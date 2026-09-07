namespace AgentWorkflow.Core.Intake;

/// <summary>
/// The only mailbox-specific seam. Graph (shared mailbox) in production; a drop directory for development and tests.
/// </summary>
public interface IMailboxClient
{
    /// <summary>Messages in the inbox not yet dispositioned, oldest first.</summary>
    Task<IReadOnlyList<InboundMessage>> ListNewAsync(CancellationToken cancellationToken = default);

    Task<byte[]> GetAttachmentContentAsync(string messageId, string attachmentId, CancellationToken cancellationToken = default);

    /// <summary>Moves the message out of the inbox (Processed or Rejected) so it is not picked up again.</summary>
    Task MarkAsync(string messageId, IntakeDisposition disposition, string reason, CancellationToken cancellationToken = default);
}
