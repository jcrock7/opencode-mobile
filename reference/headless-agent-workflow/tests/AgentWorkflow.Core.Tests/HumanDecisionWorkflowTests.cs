using AgentWorkflow.Core.Agents;
using AgentWorkflow.Core.Models;
using AgentWorkflow.Core.Runtime;
using AgentWorkflow.Core.Tests.Fakes;
using AgentWorkflow.Core.Workflow;
using Microsoft.Agents.AI.Workflows;
using Microsoft.Agents.AI.Workflows.Checkpointing;
using Microsoft.Extensions.AI;
using Xunit;

namespace AgentWorkflow.Core.Tests;

/// <summary>
/// Drives the full headless cycle: start -> halt for a human -> (process restart) -> resume -> complete.
/// The "restart" is real: the first checkpoint store is disposed and a brand-new workflow, store,
/// and runner are created before resuming, exactly as a second host instance would.
/// </summary>
public sealed class HumanDecisionWorkflowTests : IDisposable
{
    private const string AssessmentJson =
        """
        {"summary":"PO-1001 is on hold because the vendor bank account changed.","recommendation":"Release the hold","rationale":"The bank change was confirmed by the vendor master record.","riskLevel":"Medium","evidence":["get_purchase_order: hold reason BANK_CHANGE","get_vendor_profile: bank change verified 2026-09-01"],"proposedAction":"Release the payment hold on PO-1001"}
        """;

    private const string ActionReportJson =
        """
        {"succeeded":true,"summary":"Called release_purchase_order_hold for PO-1001; status is now Released."}
        """;

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "agent-workflow-tests", Guid.NewGuid().ToString("N"));

    private static readonly WorkflowTrigger s_trigger = new(
        "PO-1001",
        "PurchaseOrderHold",
        "Purchase order PO-1001 was placed on payment hold by the ERP.",
        RequestedBy: "erp-events",
        Attributes: new Dictionary<string, string> { ["vendor"] = "Contoso Valves" });

    private sealed class TestWorkflowFactory(IChatClient chatClient) : IWorkflowFactory
    {
        public string Name => HumanDecisionWorkflow.Name;

        public Task<Microsoft.Agents.AI.Workflows.Workflow> CreateAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(HumanDecisionWorkflow.Build(
                WorkflowAgents.CreateAnalyst(chatClient, []),
                WorkflowAgents.CreateOperator(chatClient, [])));
    }

    private (WorkflowRunner Runner, FileSystemJsonCheckpointStore Store) CreateRunner(IChatClient chatClient, IPendingDecisionStore pending, IDecisionChannel channel)
    {
        var store = new FileSystemJsonCheckpointStore(new DirectoryInfo(Path.Combine(_dir, "checkpoints")));
        var manager = CheckpointManager.CreateJson(store, WorkflowJson.CheckpointOptions);
        return (new WorkflowRunner(new TestWorkflowFactory(chatClient), manager, pending, channel), store);
    }

    [Fact]
    public async Task Start_halts_for_human_and_persists_a_resumable_pending_decision()
    {
        var chat = new ScriptedChatClient(AssessmentJson);
        var pendingStore = new FilePendingDecisionStore(Path.Combine(_dir, "pending"));
        var channel = new RecordingDecisionChannel();
        (WorkflowRunner runner, FileSystemJsonCheckpointStore store) = CreateRunner(chat, pendingStore, channel);
        using (store)
        {
            WorkflowRunOutcome outcome = await runner.StartAsync(s_trigger);

            Assert.Equal(RunStatusKind.WaitingForHuman, outcome.Status);
            Assert.NotNull(outcome.Pending);
            Assert.Equal("PO-1001", outcome.Pending.Request.CaseId);
            Assert.Equal("Release the payment hold on PO-1001", outcome.Pending.Request.Assessment.ProposedAction);
            Assert.Equal(HumanDecisionWorkflow.DecisionPortId, outcome.Pending.PortId);
            Assert.Equal(HumanDecisionWorkflow.Name, outcome.Pending.WorkflowName);
            Assert.Equal("conversation-1", outcome.Pending.ChannelReference);

            Assert.Single(channel.Notified);
            Assert.Single(chat.Calls); // only the analyst ran; the operator must wait for the human

            PendingDecision? persisted = await pendingStore.GetAsync(outcome.Pending.RequestId);
            Assert.NotNull(persisted);
            Assert.Equal(outcome.SessionId, persisted.SessionId);
        }
    }

    [Fact]
    public async Task Approved_decision_resumes_in_a_new_process_and_runs_the_operator()
    {
        var pendingStore = new FilePendingDecisionStore(Path.Combine(_dir, "pending"));
        var channel = new RecordingDecisionChannel();

        // Process 1: run until the human is needed.
        string requestId;
        DecisionRequest request;
        {
            var chat = new ScriptedChatClient(AssessmentJson);
            (WorkflowRunner runner, FileSystemJsonCheckpointStore store) = CreateRunner(chat, pendingStore, channel);
            using (store)
            {
                WorkflowRunOutcome outcome = await runner.StartAsync(s_trigger);
                Assert.Equal(RunStatusKind.WaitingForHuman, outcome.Status);
                requestId = outcome.Pending!.RequestId;
                request = outcome.Pending.Request;
            }
        }

        // Process 2: fresh workflow instance, fresh checkpoint store on the same durable storage.
        {
            var chat = new ScriptedChatClient(ActionReportJson);
            (WorkflowRunner runner, FileSystemJsonCheckpointStore store) = CreateRunner(chat, pendingStore, channel);
            using (store)
            {
                var decision = new Decision(request, DecisionOutcome.Approved, "jane.doe@contoso.com", "Looks right, go ahead.", DateTimeOffset.UtcNow);
                WorkflowRunOutcome outcome = await runner.ResumeAsync(requestId, decision);

                Assert.Equal(RunStatusKind.Completed, outcome.Status);
                Assert.NotNull(outcome.Result);
                Assert.Equal(DecisionOutcome.Approved, outcome.Result.Outcome);
                Assert.Equal("jane.doe@contoso.com", outcome.Result.DecidedBy);
                Assert.Contains("release_purchase_order_hold", outcome.Result.ActionTaken);

                Assert.Single(chat.Calls); // the operator agent ran exactly once
                Assert.Contains("Release the payment hold on PO-1001", string.Join('\n', chat.Calls[0].Select(m => m.Text)));

                Assert.Single(channel.Completed);
                Assert.Null(await pendingStore.GetAsync(requestId));
            }
        }
    }

    [Fact]
    public async Task Rejected_decision_completes_without_running_the_operator()
    {
        var pendingStore = new InMemoryPendingDecisionStore();
        var channel = new RecordingDecisionChannel();
        var chat = new ScriptedChatClient(AssessmentJson /* no operator response: it must not be called */);

        (WorkflowRunner runner, FileSystemJsonCheckpointStore store) = CreateRunner(chat, pendingStore, channel);
        using (store)
        {
            WorkflowRunOutcome started = await runner.StartAsync(s_trigger);
            var decision = new Decision(started.Pending!.Request, DecisionOutcome.Rejected, "john.roe@contoso.com", "Vendor change not verified by phone.", DateTimeOffset.UtcNow);

            WorkflowRunOutcome outcome = await runner.ResumeAsync(started.Pending.RequestId, decision);

            Assert.Equal(RunStatusKind.Completed, outcome.Status);
            Assert.Equal(DecisionOutcome.Rejected, outcome.Result!.Outcome);
            Assert.Null(outcome.Result.ActionTaken);
            Assert.Single(chat.Calls);
            Assert.Single(channel.Completed);
        }
    }

    [Fact]
    public async Task Claiming_a_decision_twice_fails_the_second_time()
    {
        var store = new InMemoryPendingDecisionStore();
        var pending = new PendingDecision("r1", HumanDecisionWorkflow.Name, "s1", "c1", HumanDecisionWorkflow.DecisionPortId,
            new DecisionRequest("PO-1", "PurchaseOrderHold", new Assessment("s", "r", "why", "Low", [], "act"), DateTimeOffset.UtcNow),
            DateTimeOffset.UtcNow, null);
        await store.SaveAsync(pending);

        Assert.True(await store.TryClaimAsync("r1", "a@contoso.com"));
        Assert.False(await store.TryClaimAsync("r1", "b@contoso.com"));
        Assert.Equal("a@contoso.com", (await store.GetAsync("r1"))!.ClaimedBy);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_dir))
            {
                Directory.Delete(_dir, recursive: true);
            }
        }
        catch
        {
            // best effort cleanup
        }
    }
}
