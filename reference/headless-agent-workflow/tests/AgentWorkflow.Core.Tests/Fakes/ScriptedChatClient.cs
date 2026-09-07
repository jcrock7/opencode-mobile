using System.Collections.Concurrent;
using Microsoft.Extensions.AI;

namespace AgentWorkflow.Core.Tests.Fakes;

/// <summary>
/// Stands in for Azure OpenAI. Each call returns the next scripted assistant message, so the
/// workflow's control flow, checkpointing, and resume logic can be tested without a model.
/// </summary>
public sealed class ScriptedChatClient : IChatClient
{
    private readonly ConcurrentQueue<string> _responses;

    public ScriptedChatClient(params string[] responses)
    {
        _responses = new ConcurrentQueue<string>(responses);
    }

    public List<IReadOnlyList<ChatMessage>> Calls { get; } = [];

    public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
    {
        Calls.Add(messages.ToList());
        if (!_responses.TryDequeue(out string? next))
        {
            throw new InvalidOperationException("ScriptedChatClient ran out of scripted responses.");
        }

        return Task.FromResult(new ChatResponse(new ChatMessage(ChatRole.Assistant, next)));
    }

    public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ChatResponse response = await GetResponseAsync(messages, options, cancellationToken);
        yield return new ChatResponseUpdate(ChatRole.Assistant, response.Text);
    }

    public object? GetService(Type serviceType, object? serviceKey = null) => null;

    public void Dispose()
    {
    }
}
