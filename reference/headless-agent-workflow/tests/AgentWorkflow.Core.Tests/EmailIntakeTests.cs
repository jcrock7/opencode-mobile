using System.IO.Packaging;
using System.Text;
using AgentWorkflow.Core.Intake;
using AgentWorkflow.Core.Land;
using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;
using AgentWorkflow.Core.Tests.Fakes;
using AgentWorkflow.Core.Workflow;
using AgentWorkflow.Host.Intake;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Agents.AI.Workflows.Checkpointing;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Options;
using Xunit;

namespace AgentWorkflow.Core.Tests;

public sealed class EmailIntakeTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "agent-workflow-tests", Guid.NewGuid().ToString("N"));

    private static EmailIntakeOptions Options(string dir) => new()
    {
        Enabled = true,
        Mode = "Directory",
        DropDirectory = Path.Combine(dir, "drop"),
        Directory = Path.Combine(dir, "intake"),
        AllowedSenderDomains = ["keystoneland.com"],
        BrokerFirms = { ["keystoneland.com"] = "Keystone Land Services" },
        WorkflowName = LeaseReviewWorkflow.Name,
    };

    private static InboundMessage Message(string from, string subject, string body, params InboundAttachment[] attachments) =>
        new("m1", "<m1@keystoneland.com>", from, "Jane Broker", subject, body, DateTimeOffset.UtcNow, attachments);

    // ---------------- parser ----------------

    [Fact]
    public void Parser_reads_fields_from_body_and_picks_the_lease_attachment()
    {
        var msg = Message("jane@keystoneland.com", "Miller lease for review",
            "Hi,\nLessor: John A. and Mary E. Miller\nCounty: Washington County\nState: pa\nTract: T-3391\nGross acres: 118.42\nThanks",
            new InboundAttachment("a1", "cover-letter.pdf", "application/pdf", 20_000),
            new InboundAttachment("a2", "Miller_Lease_Draft.pdf", "application/pdf", 300_000),
            new InboundAttachment("a3", "photo.jpg", "image/jpeg", 2_000_000));

        IntakeParseResult r = LeaseEmailParser.Parse(msg, Options("x"));

        Assert.True(r.Accepted);
        Assert.Equal("Keystone Land Services", r.BrokerFirm);
        Assert.Equal("John A. and Mary E. Miller", r.Lessor);
        Assert.Equal("Washington", r.County);
        Assert.Equal("PA", r.State);
        Assert.Equal("T-3391", r.TractId);
        Assert.Equal("118.42", r.GrossAcres);
        Assert.Equal("a2", r.LeaseAttachment!.Id);
    }

    [Fact]
    public void Parser_falls_back_to_the_subject_convention()
    {
        var msg = Message("jane@keystoneland.com", "Lease submission: Miller - Washington County, PA", "see attached",
            new InboundAttachment("a1", "draft.docx", null, 50_000));

        IntakeParseResult r = LeaseEmailParser.Parse(msg, Options("x"));

        Assert.True(r.Accepted);
        Assert.Equal("Miller", r.Lessor);
        Assert.Equal("Washington", r.County);
        Assert.Equal("PA", r.State);
    }

    [Fact]
    public void Parser_rejects_unknown_senders_and_missing_attachments()
    {
        Assert.False(LeaseEmailParser.Parse(Message("someone@gmail.com", "Lease", "", new InboundAttachment("a", "lease.pdf", null, 10)), Options("x")).Accepted);
        Assert.Contains("not an allowed broker", LeaseEmailParser.Parse(Message("someone@gmail.com", "Lease", "", new InboundAttachment("a", "lease.pdf", null, 10)), Options("x")).RejectReason);
        Assert.False(LeaseEmailParser.Parse(Message("jane@keystoneland.com", "Lease", "", new InboundAttachment("a", "lease.exe", null, 10)), Options("x")).Accepted);
        Assert.False(LeaseEmailParser.Parse(Message("jane@keystoneland.com", "Lease", ""), Options("x")).Accepted);
    }

    // ---------------- text extraction ----------------

    [Fact]
    public void Extracts_text_from_docx()
    {
        byte[] docx = BuildDocx("OIL AND GAS LEASE", "Royalty of eighteen percent (18%).");

        string text = DocumentTextExtractor.Extract("lease.docx", docx);

        Assert.Contains("OIL AND GAS LEASE", text);
        Assert.Contains("eighteen percent", text);
    }

    [Fact]
    public void Extracts_text_from_a_pdf_with_a_text_layer()
    {
        string text = DocumentTextExtractor.Extract("lease.pdf", BuildMinimalPdf("Paid-Up Oil and Gas Lease"));

        Assert.Contains("Oil", text);
        Assert.Contains("Lease", text);
    }

    // ---------------- end to end through the drop folder ----------------

    [Fact]
    public async Task Drop_folder_email_creates_an_intake_record_and_starts_the_lease_review()
    {
        EmailIntakeOptions options = Options(_dir);
        string folder = Path.Combine(options.DropDirectory!, "2026-09-07-miller");
        Directory.CreateDirectory(folder);
        await File.WriteAllTextAsync(Path.Combine(folder, "message.json"),
            """{"from":"jane@keystoneland.com","fromName":"Jane Broker","subject":"Lease submission: Miller - Washington County, PA","body":"Tract: T-3391\nGross acres: 118.42\n"}""");
        await File.WriteAllBytesAsync(Path.Combine(folder, "Miller_Lease_Draft.docx"), BuildDocx("OIL AND GAS LEASE (Paid-Up)", "Lessor: John A. Miller and Mary E. Miller", "Royalty: 18% cost-free."));

        // Also a message that must be rejected and must not stop the good one.
        string bad = Path.Combine(options.DropDirectory!, "2026-09-07-spam");
        Directory.CreateDirectory(bad);
        await File.WriteAllTextAsync(Path.Combine(bad, "message.json"), """{"from":"x@gmail.com","subject":"hi","body":""}""");
        await File.WriteAllTextAsync(Path.Combine(bad, "lease.txt"), "not a broker");

        var chat = new ScriptedChatClient(LeaseReviewWorkflowTests.LeaseReviewJson);
        var channel = new RecordingDecisionChannel();
        var store = new FileIntakeStore(options.Directory);
        using var checkpoints = new FileSystemJsonCheckpointStore(new DirectoryInfo(Path.Combine(_dir, "cp")));
        var runner = new WorkflowRunner(new Factory(chat), CheckpointManager.CreateJson(checkpoints, WorkflowJson.CheckpointOptions), new InMemoryPendingDecisionStore(), channel);
        var processor = new EmailIntakeProcessor(new DirectoryMailboxClient(options.DropDirectory!), store, new WorkflowRunnerRegistry([runner]), Microsoft.Extensions.Options.Options.Create(options));

        IntakeRunSummary summary = await processor.RunOnceAsync();

        Assert.Equal(2, summary.Seen);
        Assert.Equal(1, summary.Started);
        Assert.Equal(1, summary.Rejected);
        Assert.Equal(0, summary.Failed);

        // Record + document filed; workflow parked for the landman with the intake attributes on the request.
        LeaseIntakeRecord record = Assert.Single(await store.ListRecordsAsync());
        Assert.Equal("UnderReview", record.Stage);
        Assert.Equal("Keystone Land Services", record.BrokerFirm);
        Assert.Equal("Miller", record.Lessor);
        Assert.Equal("T-3391", record.TractId);
        Assert.NotNull(record.WorkflowSessionId);
        Assert.Contains("Royalty: 18% cost-free.", FileIntakeStore.ReadDocumentText(options.Directory, record.DocumentId));

        PendingDecision pending = Assert.Single(channel.Notified);
        Assert.Equal(record.LeaseId, pending.Request.CaseId);
        Assert.Equal("email", pending.Request.Attributes!["source"]);
        Assert.Equal(record.DocumentId, pending.Request.Attributes["documentId"]);
        Assert.Equal("PA", pending.Request.Attributes["state"]);
        Assert.Contains(record.DocumentId, string.Join('\n', chat.Calls.Single().Select(m => m.Text)));

        // Messages were dispositioned; a second pass finds nothing.
        Assert.True(Directory.Exists(Path.Combine(options.DropDirectory!, "processed", "2026-09-07-miller")));
        Assert.True(Directory.Exists(Path.Combine(options.DropDirectory!, "rejected", "2026-09-07-spam")));
        Assert.Equal(0, (await processor.RunOnceAsync()).Seen);
    }

    private sealed class Factory(IChatClient chat) : IWorkflowFactory
    {
        public string Name => LeaseReviewWorkflow.Name;
        public Task<Microsoft.Agents.AI.Workflows.Workflow> CreateAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(LeaseReviewWorkflow.Build(LeaseReviewAgents.CreateLeaseAnalyst(chat, []), LeaseReviewAgents.CreateLandOperator(chat, [])));
    }

    private static byte[] BuildDocx(params string[] paragraphs)
    {
        using var ms = new MemoryStream();
        using (Package package = Package.Open(ms, FileMode.Create, FileAccess.ReadWrite))
        {
            var uri = new Uri("/word/document.xml", UriKind.Relative);
            PackagePart part = package.CreatePart(uri, "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml");
            package.CreateRelationship(uri, TargetMode.Internal, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument");
            string body = string.Concat(paragraphs.Select(p => $"<w:p><w:r><w:t>{System.Security.SecurityElement.Escape(p)}</w:t></w:r></w:p>"));
            byte[] xml = Encoding.UTF8.GetBytes($"""<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>""");
            using Stream s = part.GetStream(FileMode.Create);
            s.Write(xml);
        }

        return ms.ToArray();
    }

    /// <summary>A hand-assembled single-page PDF with one line of Helvetica text.</summary>
    private static byte[] BuildMinimalPdf(string text)
    {
        string content = $"BT /F1 12 Tf 72 720 Td ({text}) Tj ET";
        var objects = new[]
        {
            "<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            $"<< /Length {content.Length} >>\nstream\n{content}\nendstream",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        };

        var sb = new StringBuilder("%PDF-1.4\n");
        var offsets = new List<int>();
        for (int i = 0; i < objects.Length; i++)
        {
            offsets.Add(Encoding.ASCII.GetByteCount(sb.ToString()));
            sb.Append($"{i + 1} 0 obj\n{objects[i]}\nendobj\n");
        }

        int xref = Encoding.ASCII.GetByteCount(sb.ToString());
        sb.Append($"xref\n0 {objects.Length + 1}\n0000000000 65535 f \n");
        foreach (int o in offsets)
        {
            sb.Append($"{o:0000000000} 00000 n \n");
        }

        sb.Append($"trailer\n<< /Size {objects.Length + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n");
        return Encoding.ASCII.GetBytes(sb.ToString());
    }

    public void Dispose()
    {
        try { if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true); } catch { }
    }
}
