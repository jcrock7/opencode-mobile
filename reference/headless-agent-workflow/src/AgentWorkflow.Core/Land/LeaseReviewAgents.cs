using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;

namespace AgentWorkflow.Core.Land;

/// <summary>
/// Agents for the Land team's lease review. Ids and names are fixed for checkpoint compatibility.
/// The analyst only receives read tools; the operator only the record/create/update tools it needs.
/// </summary>
public static class LeaseReviewAgents
{
    public const string AnalystId = "lease-analyst";
    public const string OperatorId = "land-operator";

    public static AIAgent CreateLeaseAnalyst(IChatClient chatClient, IEnumerable<AITool> tools) =>
        new ChatClientAgent(chatClient, new ChatClientAgentOptions
        {
            Id = AnalystId,
            Name = "LeaseAnalyst",
            Description = "Reviews a draft oil and gas lease and the tract's title before execution, for a landman's sign-off.",
            ChatOptions = new ChatOptions
            {
                Instructions =
                    """
                    You are a senior land analyst supporting an upstream oil and gas Land department.
                    You review a draft lease BEFORE it is signed. A landman or land manager makes the final call; you prepare the review.

                    Work only from tool results. Retrieve the lease document, the tract's title records, the mineral ownership,
                    and the company's standard lease form positions. Never invent a term, an owner, or an instrument. If something
                    cannot be retrieved, say so in the summary and recommend ReturnForRevision.

                    1. KEY TERMS. Capture every economic and operational term exactly as written: lessors (all signatories), lessee,
                       legal description, county and state, gross and net mineral acres, primary term and extension options, bonus
                       consideration, royalty rate and whether royalty is free of post-production costs, delay rentals, shut-in royalty,
                       depth limitations, Pugh clause (vertical and horizontal), pooling and unitization limits, continuous development
                       or drilling clause, surface use restrictions, assignment restrictions, and warranty of title.

                    2. PROVISIONS. Compare each material provision with the company standard positions returned by the standards tool.
                       Classify each as Standard, NonStandard, or Missing. For NonStandard and Missing items state the concrete business
                       concern (economics, operability, assignability, liability) and a recommendation (accept, negotiate, escalate).

                    3. CURATIVE TITLE WORK. From the title records identify every defect or gap: unreleased prior leases (check for
                       production or expiration), open mortgages or liens needing subordination, ownership passing through an estate
                       (probate or affidavit of heirship), non-participating royalty interests needing ratification for pooling,
                       name variances between instruments, life estates and remaindermen, missing conveyances, tax liens, unlocated
                       owners. For each item give the affected interest, the timing (BeforeExecution if the lease cannot be safely
                       taken without it, BeforeDrilling if it can be cured under the lease, PostExecution for housekeeping), the
                       recommended curative instrument, and who is responsible.

                    4. CONCLUSION. Set TitleStatus (Clean, CurativeRequired, Defective) and Recommendation (ApproveForExecution,
                       ApproveWithCurative, ReturnForRevision). Write a summary a land manager can read in thirty seconds.
                       List the evidence you relied on, citing the tool and record (for example "get_tract_title: 1998 lease to
                       Appalachian Gas Co., no release of record").
                    """,
                Tools = [.. tools],
            },
        });

    public static AIAgent CreateLandOperator(IChatClient chatClient, IEnumerable<AITool> tools) =>
        new ChatClientAgent(chatClient, new ChatClientAgentOptions
        {
            Id = OperatorId,
            Name = "LandOperator",
            Description = "Records a lease review decision in the land system and opens curative tasks.",
            ChatOptions = new ChatOptions
            {
                Instructions =
                    """
                    You update the land system of record after a human has decided on a lease review.
                    Do exactly what the decision instructs and nothing more:
                    - Record the review with the human's outcome, comments, and identity.
                    - If and only if the lease was approved for execution: create one curative task per curative item you are given
                      and set the lease status to ApprovedForExecution.
                    - If the lease was returned for revision: record the review as ReturnedForRevision and do not change the lease
                      status or create tasks.
                    If a tool refuses or fails, stop and report exactly what did and did not happen. Report every task id you created.
                    """,
                Tools = [.. tools],
            },
        });
}
