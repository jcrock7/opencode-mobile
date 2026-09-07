using System.Text.Json;

namespace AgentWorkflow.Core.Intake;

/// <summary>
/// Durable intake records and lease documents. The PoC writes files; production points this at a SharePoint
/// list and document library through Graph, or at Dataverse. The land MCP server reads the same store.
/// </summary>
public interface IIntakeStore
{
    /// <summary>The record created for this email, if any (idempotency across retries).</summary>
    Task<LeaseIntakeRecord?> FindByMessageAsync(string internetMessageId, CancellationToken cancellationToken = default);
    Task<string> NextLeaseIdAsync(CancellationToken cancellationToken = default);
    Task SaveDocumentAsync(string documentId, string fileName, byte[] content, string extractedText, CancellationToken cancellationToken = default);
    Task SaveRecordAsync(LeaseIntakeRecord record, CancellationToken cancellationToken = default);
    Task<LeaseIntakeRecord?> GetRecordAsync(string leaseId, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<LeaseIntakeRecord>> ListRecordsAsync(CancellationToken cancellationToken = default);
}

/// <summary>
/// File layout: <c>records/{leaseId}.json</c>, <c>documents/{documentId}{ext}</c> (original) and
/// <c>documents/{documentId}.txt</c> (extracted text the agent reads), <c>counter.txt</c>.
/// </summary>
public sealed class FileIntakeStore : IIntakeStore
{
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly DirectoryInfo _root;
    private readonly DirectoryInfo _records;
    private readonly DirectoryInfo _documents;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public FileIntakeStore(string directory)
    {
        _root = System.IO.Directory.CreateDirectory(directory);
        _records = System.IO.Directory.CreateDirectory(Path.Combine(_root.FullName, "records"));
        _documents = System.IO.Directory.CreateDirectory(Path.Combine(_root.FullName, "documents"));
    }

    public string RootPath => _root.FullName;

    public async Task<LeaseIntakeRecord?> FindByMessageAsync(string internetMessageId, CancellationToken cancellationToken = default) =>
        (await ListRecordsAsync(cancellationToken).ConfigureAwait(false)).FirstOrDefault(r => string.Equals(r.InternetMessageId, internetMessageId, StringComparison.Ordinal));

    public async Task<string> NextLeaseIdAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            string counterPath = Path.Combine(_root.FullName, "counter.txt");
            int next = File.Exists(counterPath) && int.TryParse(await File.ReadAllTextAsync(counterPath, cancellationToken).ConfigureAwait(false), out int n) ? n + 1 : 1;
            await File.WriteAllTextAsync(counterPath, next.ToString(), cancellationToken).ConfigureAwait(false);
            return $"L-{DateTimeOffset.UtcNow:yyyy}-{next:0000}";
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SaveDocumentAsync(string documentId, string fileName, byte[] content, string extractedText, CancellationToken cancellationToken = default)
    {
        string ext = Path.GetExtension(fileName);
        await File.WriteAllBytesAsync(Path.Combine(_documents.FullName, documentId + ext), content, cancellationToken).ConfigureAwait(false);
        await File.WriteAllTextAsync(Path.Combine(_documents.FullName, documentId + ".txt"), extractedText, cancellationToken).ConfigureAwait(false);
    }

    public Task SaveRecordAsync(LeaseIntakeRecord record, CancellationToken cancellationToken = default) =>
        File.WriteAllTextAsync(Path.Combine(_records.FullName, record.LeaseId + ".json"), JsonSerializer.Serialize(record, s_json), cancellationToken);

    public async Task<LeaseIntakeRecord?> GetRecordAsync(string leaseId, CancellationToken cancellationToken = default)
    {
        string path = Path.Combine(_records.FullName, leaseId + ".json");
        return File.Exists(path)
            ? JsonSerializer.Deserialize<LeaseIntakeRecord>(await File.ReadAllTextAsync(path, cancellationToken).ConfigureAwait(false), s_json)
            : null;
    }

    public async Task<IReadOnlyList<LeaseIntakeRecord>> ListRecordsAsync(CancellationToken cancellationToken = default)
    {
        var list = new List<LeaseIntakeRecord>();
        foreach (FileInfo file in _records.EnumerateFiles("*.json"))
        {
            if (JsonSerializer.Deserialize<LeaseIntakeRecord>(await File.ReadAllTextAsync(file.FullName, cancellationToken).ConfigureAwait(false), s_json) is { } r)
            {
                list.Add(r);
            }
        }

        return list.OrderBy(r => r.ReceivedAt).ToList();
    }

    /// <summary>Reads the extracted text for a document id, or null. Used by the sample MCP server.</summary>
    public static string? ReadDocumentText(string directory, string documentId)
    {
        string path = Path.Combine(directory, "documents", documentId + ".txt");
        return File.Exists(path) ? File.ReadAllText(path) : null;
    }
}
