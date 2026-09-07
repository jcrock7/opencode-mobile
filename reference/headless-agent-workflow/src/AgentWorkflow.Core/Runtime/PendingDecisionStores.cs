using System.Collections.Concurrent;
using System.Text.Json;

namespace AgentWorkflow.Core.Runtime;

/// <summary>In-memory store for tests and single-process development.</summary>
public sealed class InMemoryPendingDecisionStore : IPendingDecisionStore
{
    private readonly ConcurrentDictionary<string, PendingDecision> _items = new(StringComparer.Ordinal);

    public Task SaveAsync(PendingDecision pending, CancellationToken cancellationToken = default)
    {
        _items[pending.RequestId] = pending;
        return Task.CompletedTask;
    }

    public Task<PendingDecision?> GetAsync(string requestId, CancellationToken cancellationToken = default) =>
        Task.FromResult(_items.TryGetValue(requestId, out PendingDecision? p) ? p : null);

    public Task<IReadOnlyList<PendingDecision>> ListAsync(CancellationToken cancellationToken = default) =>
        Task.FromResult<IReadOnlyList<PendingDecision>>(_items.Values.OrderBy(p => p.CreatedAt).ToList());

    public Task<bool> TryClaimAsync(string requestId, string decidedBy, CancellationToken cancellationToken = default)
    {
        while (_items.TryGetValue(requestId, out PendingDecision? current))
        {
            if (current.ClaimedBy is not null)
            {
                return Task.FromResult(false);
            }

            if (_items.TryUpdate(requestId, current with { ClaimedBy = decidedBy }, current))
            {
                return Task.FromResult(true);
            }
        }

        return Task.FromResult(false);
    }

    public Task RemoveAsync(string requestId, CancellationToken cancellationToken = default)
    {
        _items.TryRemove(requestId, out _);
        return Task.CompletedTask;
    }
}

/// <summary>
/// One JSON file per pending decision. Survives restarts on a single node; replace with
/// Cosmos DB, SQL, or Table Storage when running more than one host instance.
/// </summary>
public sealed class FilePendingDecisionStore : IPendingDecisionStore
{
    private static readonly JsonSerializerOptions s_json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private readonly DirectoryInfo _directory;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public FilePendingDecisionStore(string directory)
    {
        _directory = Directory.CreateDirectory(directory);
    }

    private string PathFor(string requestId) => Path.Combine(_directory.FullName, Uri.EscapeDataString(requestId) + ".json");

    public async Task SaveAsync(PendingDecision pending, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await File.WriteAllTextAsync(PathFor(pending.RequestId), JsonSerializer.Serialize(pending, s_json), cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<PendingDecision?> GetAsync(string requestId, CancellationToken cancellationToken = default)
    {
        string path = PathFor(requestId);
        if (!File.Exists(path))
        {
            return null;
        }

        string json = await File.ReadAllTextAsync(path, cancellationToken).ConfigureAwait(false);
        return JsonSerializer.Deserialize<PendingDecision>(json, s_json);
    }

    public async Task<IReadOnlyList<PendingDecision>> ListAsync(CancellationToken cancellationToken = default)
    {
        var list = new List<PendingDecision>();
        foreach (FileInfo file in _directory.EnumerateFiles("*.json"))
        {
            string json = await File.ReadAllTextAsync(file.FullName, cancellationToken).ConfigureAwait(false);
            if (JsonSerializer.Deserialize<PendingDecision>(json, s_json) is { } pending)
            {
                list.Add(pending);
            }
        }

        return list.OrderBy(p => p.CreatedAt).ToList();
    }

    public async Task<bool> TryClaimAsync(string requestId, string decidedBy, CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            PendingDecision? current = await GetAsync(requestId, cancellationToken).ConfigureAwait(false);
            if (current is null || current.ClaimedBy is not null)
            {
                return false;
            }

            await File.WriteAllTextAsync(PathFor(requestId), JsonSerializer.Serialize(current with { ClaimedBy = decidedBy }, s_json), cancellationToken).ConfigureAwait(false);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    public Task RemoveAsync(string requestId, CancellationToken cancellationToken = default)
    {
        string path = PathFor(requestId);
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        return Task.CompletedTask;
    }
}
