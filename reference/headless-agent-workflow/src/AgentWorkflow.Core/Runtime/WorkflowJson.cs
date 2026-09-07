using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace AgentWorkflow.Core.Runtime;

/// <summary>
/// Serializer options handed to <c>CheckpointManager.CreateJson</c>. Agent Framework serializes its own
/// types with a source-generated context; these options are what it uses for application message types
/// (the trigger, the decision request, the decision) that travel through the graph and into checkpoints.
/// </summary>
public static class WorkflowJson
{
    public static JsonSerializerOptions CheckpointOptions { get; } = Create();

    private static JsonSerializerOptions Create()
    {
        var options = new JsonSerializerOptions
        {
            TypeInfoResolver = new DefaultJsonTypeInfoResolver(),
            PropertyNameCaseInsensitive = true,
        };
        options.Converters.Add(new JsonStringEnumConverter());
        options.MakeReadOnly();
        return options;
    }
}
