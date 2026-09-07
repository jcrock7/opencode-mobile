using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;

namespace AgentWorkflow.Core.Intake;

public sealed record IntakeRunSummary(int Seen, int Started, int Rejected, int Skipped, int Failed);

/// <summary>
/// One intake pass: for every new message, validate and parse, file the lease document, create the intake
/// record, start the review workflow, and disposition the message. Each message is handled independently so
/// one bad email never blocks the rest. A message that fails mid-way stays in the inbox for the next pass;
/// the record written before the workflow starts makes the retry idempotent.
/// </summary>
public sealed class EmailIntakeProcessor
{
    private readonly IMailboxClient _mailbox;
    private readonly IIntakeStore _store;
    private readonly WorkflowRunnerRegistry _runners;
    private readonly EmailIntakeOptions _options;
    private readonly ILogger<EmailIntakeProcessor> _logger;
    private readonly SemaphoreSlim _passGate = new(1, 1);

    public EmailIntakeProcessor(
        IMailboxClient mailbox,
        IIntakeStore store,
        WorkflowRunnerRegistry runners,
        IOptions<EmailIntakeOptions> options,
        ILogger<EmailIntakeProcessor>? logger = null)
    {
        _mailbox = mailbox;
        _store = store;
        _runners = runners;
        _options = options.Value;
        _logger = logger ?? NullLogger<EmailIntakeProcessor>.Instance;
    }

    /// <summary>
    /// Runs one pass. Passes are serialized: the timer and the on-demand endpoint may overlap, and a message
    /// that is still being processed must not be listed as "new" by a second pass.
    /// </summary>
    public async Task<IntakeRunSummary> RunOnceAsync(CancellationToken cancellationToken = default)
    {
        if (!await _passGate.WaitAsync(TimeSpan.Zero, cancellationToken).ConfigureAwait(false))
        {
            _logger.LogDebug("Intake pass skipped: another pass is in progress.");
            return new IntakeRunSummary(0, 0, 0, 0, 0);
        }

        try
        {
            return await RunPassAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _passGate.Release();
        }
    }

    private async Task<IntakeRunSummary> RunPassAsync(CancellationToken cancellationToken)
    {
        int started = 0, rejected = 0, skipped = 0, failed = 0;
        IReadOnlyList<InboundMessage> messages = await _mailbox.ListNewAsync(cancellationToken).ConfigureAwait(false);

        foreach (InboundMessage message in messages)
        {
            try
            {
                switch (await ProcessAsync(message, cancellationToken).ConfigureAwait(false))
                {
                    case IntakeDisposition.Processed: started++; break;
                    case IntakeDisposition.Rejected: rejected++; break;
                    default: skipped++; break;
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failed++;
                _logger.LogError(ex, "Intake of message {MessageId} from {From} failed; it stays in the inbox for retry.", message.Id, message.FromAddress);
            }
        }

        return new IntakeRunSummary(messages.Count, started, rejected, skipped, failed);
    }

    private async Task<IntakeDisposition?> ProcessAsync(InboundMessage message, CancellationToken cancellationToken)
    {
        LeaseIntakeRecord? existing = await _store.FindByMessageAsync(message.InternetMessageId, cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            if (existing.Stage == "Received")
            {
                // A previous pass filed the lease but crashed before the review started: start it now, once.
                _logger.LogWarning("Message {MessageId} was filed as {LeaseId} but its review never started; starting it.", message.Id, existing.LeaseId);
                await StartReviewAsync(message, existing, cancellationToken).ConfigureAwait(false);
                return IntakeDisposition.Processed;
            }

            _logger.LogInformation("Message {MessageId} already produced {LeaseId} ({Stage}); marking processed.", message.Id, existing.LeaseId, existing.Stage);
            await _mailbox.MarkAsync(message.Id, IntakeDisposition.Processed, $"duplicate of {existing.LeaseId}", cancellationToken).ConfigureAwait(false);
            return null;
        }

        IntakeParseResult parsed = LeaseEmailParser.Parse(message, _options);
        if (!parsed.Accepted)
        {
            _logger.LogWarning("Rejected message {MessageId} from {From}: {Reason}", message.Id, message.FromAddress, parsed.RejectReason);
            await _mailbox.MarkAsync(message.Id, IntakeDisposition.Rejected, parsed.RejectReason!, cancellationToken).ConfigureAwait(false);
            return IntakeDisposition.Rejected;
        }

        InboundAttachment attachment = parsed.LeaseAttachment!;
        byte[] content = await _mailbox.GetAttachmentContentAsync(message.Id, attachment.Id, cancellationToken).ConfigureAwait(false);
        string text = DocumentTextExtractor.Extract(attachment.Name, content);
        if (string.IsNullOrWhiteSpace(text))
        {
            await _mailbox.MarkAsync(message.Id, IntakeDisposition.Rejected, "Attachment has no extractable text (scanned image?). Send a text PDF or run OCR.", cancellationToken).ConfigureAwait(false);
            return IntakeDisposition.Rejected;
        }

        string leaseId = await _store.NextLeaseIdAsync(cancellationToken).ConfigureAwait(false);
        string documentId = $"DOC-{leaseId}";
        await _store.SaveDocumentAsync(documentId, attachment.Name, content, text, cancellationToken).ConfigureAwait(false);

        var record = new LeaseIntakeRecord(
            leaseId, message.Id, message.InternetMessageId, message.FromAddress, message.FromName, parsed.BrokerFirm, message.Subject,
            parsed.Lessor, parsed.County, parsed.State, parsed.TractId, parsed.GrossAcres,
            documentId, attachment.Name, message.ReceivedAt, Stage: "Received");
        await _store.SaveRecordAsync(record, cancellationToken).ConfigureAwait(false);

        await StartReviewAsync(message, record, cancellationToken).ConfigureAwait(false);
        return IntakeDisposition.Processed;
    }

    private async Task StartReviewAsync(InboundMessage message, LeaseIntakeRecord record, CancellationToken cancellationToken)
    {
        var trigger = new WorkflowTrigger(
            record.LeaseId,
            "LeaseReview",
            $"Draft lease received by email from {record.BrokerFirm} ({record.BrokerEmail}). Subject: {record.Subject}",
            RequestedBy: $"email-intake:{record.BrokerEmail}",
            Attributes: Attributes(record));

        IWorkflowRunner runner = _runners.Get(_options.WorkflowName);
        record = record with { StartAttempts = record.StartAttempts + 1 };
        WorkflowRunOutcome outcome;
        try
        {
            outcome = await runner.StartAsync(trigger, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            string note = $"Start attempt {record.StartAttempts} failed: {ex.GetType().Name}: {ex.Message}";
            if (record.StartAttempts >= Math.Max(1, _options.MaxStartAttempts))
            {
                // Give up: operators see it at GET /api/intake/leases with the reason; the message is dispositioned.
                await _store.SaveRecordAsync(record with { Stage = "ReviewFailed", Notes = note }, cancellationToken).ConfigureAwait(false);
                await _mailbox.MarkAsync(message.Id, IntakeDisposition.Processed, $"{record.LeaseId} ReviewFailed after {record.StartAttempts} attempts", cancellationToken).ConfigureAwait(false);
                _logger.LogError(ex, "Intake {LeaseId}: giving up after {Attempts} failed start attempts.", record.LeaseId, record.StartAttempts);
                return;
            }

            // Leave the record at Received and the message in the inbox: the next pass retries the start.
            await _store.SaveRecordAsync(record with { Notes = note }, cancellationToken).ConfigureAwait(false);
            throw;
        }

        string stage = outcome.Status switch
        {
            RunStatusKind.WaitingForHuman => "UnderReview",
            RunStatusKind.Completed => "Reviewed",
            _ => "ReviewFailed",
        };
        await _store.SaveRecordAsync(record with { Stage = stage, WorkflowSessionId = outcome.SessionId, Notes = outcome.Error }, cancellationToken).ConfigureAwait(false);

        await _mailbox.MarkAsync(message.Id, IntakeDisposition.Processed, $"{record.LeaseId} {stage}", cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("Intake {LeaseId} from {From} started {Workflow}: {Status}.", record.LeaseId, record.BrokerEmail, runner.WorkflowName, outcome.Status);
    }

    private static Dictionary<string, string> Attributes(LeaseIntakeRecord r)
    {
        var a = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["source"] = "email",
            ["documentId"] = r.DocumentId,
            ["documentFileName"] = r.DocumentFileName,
            ["broker"] = r.BrokerFirm,
            ["brokerEmail"] = r.BrokerEmail,
        };
        if (r.State is not null) a["state"] = r.State;
        if (r.County is not null) a["county"] = r.County;
        if (r.TractId is not null) a["tractId"] = r.TractId;
        if (r.Lessor is not null) a["lessor"] = r.Lessor;
        if (r.GrossAcres is not null) a["grossAcres"] = r.GrossAcres;
        return a;
    }
}
