using System.ComponentModel;
using System.Security.Claims;
using ModelContextProtocol;
using ModelContextProtocol.Server;

namespace SampleMcpServer.Tools;

// In production the Land tools live on their own MCP server (their own app registration and app roles) in front
// of the land system of record (Quorum Land, P2 Land, Enverus, a SharePoint lease library). They share a process
// with the purchasing tools here only to keep the sample small.

public sealed record LeaseMetadata(string LeaseId, string Status, string TractId, string County, string State, string Broker, string DocumentId, DateOnly ReceivedOn);

public sealed record TitleRecord(string Instrument, string RecordedOn, string Parties, string Book, string Page, string Notes);

public sealed record TractTitle(string TractId, string LegalDescription, double GrossAcres, IReadOnlyList<TitleRecord> Records);

public sealed record MineralOwner(string Name, double DecimalInterest, string Vesting, string? Notes);

public sealed record MineralOwnership(string TractId, double GrossAcres, IReadOnlyList<MineralOwner> Owners);

public sealed record StandardPosition(string Provision, string Standard, string Tolerance);

public sealed record LeaseReviewRecord(string ReviewId, string LeaseId, string Outcome, string Summary, string DecidedBy, string? Comments, DateTimeOffset RecordedAt);

public sealed record CurativeTask(string TaskId, string LeaseId, string Category, string Description, string RecommendedInstrument, string Timing, string Status);

/// <summary>In-memory stand-in for the land system. Fictional Appalachian tract with realistic title issues.</summary>
public sealed class LandRepository
{
    private const string LeaseId = "L-2026-0142";
    private const string TractId = "T-3391";

    private readonly Dictionary<string, LeaseMetadata> _leases = new(StringComparer.OrdinalIgnoreCase)
    {
        [LeaseId] = new(LeaseId, "PendingReview", TractId, "Washington", "PA", "Keystone Land Services", "DOC-88213", new DateOnly(2026, 9, 2)),
    };

    private readonly Dictionary<string, string> _documents = new(StringComparer.OrdinalIgnoreCase)
    {
        ["DOC-88213"] =
            """
            OIL AND GAS LEASE (Paid-Up) - DRAFT FOR REVIEW

            THIS LEASE is made effective September 15, 2026 by and between JOHN A. MILLER and MARY E. MILLER, husband and wife,
            of 412 Ridge Road, Prosperity, Washington County, Pennsylvania ("Lessor"), and CONTOSO ENERGY LLC ("Lessee").

            1. GRANT. Lessor leases to Lessee the oil and gas in and under the following land in Amwell Township, Washington County,
               Pennsylvania: Tax Parcel 020-004-00-00-0012-00, being 118.42 gross acres, more or less, as described in Deed Book 3456, Page 221
               ("Leased Premises"). Lessor warrants ownership of an undivided three-fourths (3/4) interest in the oil and gas.

            2. TERM. This lease is for a primary term of five (5) years. Lessee may extend the primary term for an additional three (3) years
               by paying Lessor an extension payment equal to the bonus consideration per net mineral acre paid at signing.

            3. BONUS. Consideration of $3,500.00 per net mineral acre, paid at execution. No delay rentals are due (paid-up lease).

            4. ROYALTY. Lessee shall pay Lessor a royalty of eighteen percent (18%) of the gross proceeds received by Lessee at the point of
               sale, free of all costs of gathering, compression, dehydration, treating, processing, transportation and marketing.

            5. SHUT-IN. If a well capable of producing is shut in, Lessee shall pay $10.00 per net mineral acre per year, not to exceed two (2)
               consecutive years.

            6. POOLING. Lessee may pool the Leased Premises with other lands into units not exceeding 640 acres plus a 10% tolerance for gas.
               Lessee shall not pool any interest of Lessor without Lessor's written consent as to units exceeding that size.

            7. DEPTH LIMITATION. This lease covers only formations from the surface to the stratigraphic equivalent of the base of the
               Marcellus Shale. All deeper formations, including the Utica/Point Pleasant, are excluded and reserved to Lessor.

            8. PUGH CLAUSE. At the end of the primary term (as extended), this lease shall terminate as to all lands outside a producing unit
               and, as to lands inside a unit, as to all depths 100 feet below the deepest producing formation.

            9. CONTINUOUS DEVELOPMENT. Following the primary term, this lease is maintained only so long as no more than 180 days elapse
               between the completion of one well and the commencement of the next.

            10. SURFACE. Lessee shall have no right to use the surface of the Leased Premises for any purpose (no surface operations).

            11. ASSIGNMENT. Lessee shall not assign this lease in whole or in part without the prior written consent of Lessor, which shall not
                be unreasonably withheld; assignment to an affiliate or as security for financing is permitted without consent.

            12. WARRANTY. Lessor warrants title to the extent of the interest described in Paragraph 1 and agrees to defend the same.

            13. AUDIT. Lessor may audit Lessee's royalty accounting once per calendar year on 60 days' notice.

            14. FAVORED NATIONS. If Lessee grants a higher royalty or bonus to any lessor within Amwell Township within 12 months, Lessor shall
                receive the same.

            IN WITNESS WHEREOF ...
            """,
    };

    private readonly TractTitle _title = new(TractId,
        "Tax Parcel 020-004-00-00-0012-00, Amwell Township, Washington County, PA; Deed Book 3456, Page 221; 118.42 acres",
        118.42,
        [
            new("Warranty Deed", "2004-06-11", "Robert L. Miller and Helen Miller to John A. Miller and Mary Ellen Miller, h/w (3/4 undivided oil and gas interest conveyed with the surface)", "3456", "221", "Grantee name 'Mary Ellen Miller' differs from lease signatory 'Mary E. Miller'."),
            new("Oil and Gas Lease", "1998-03-02", "Robert L. Miller and Helen Miller to Appalachian Gas Co.", "OGL 412", "88", "5-year primary term. No release of record. No well or unit records found for this parcel. Company lease index shows no production."),
            new("Mortgage", "2019-08-20", "John A. Miller and Mary E. Miller to First Federal Savings Bank", "MB 991", "1502", "Open of record; covers the whole parcel including oil and gas."),
            new("Reservation in Deed", "1957-10-04", "Samuel Kern to Robert L. Miller", "1102", "77", "Reserves an undivided 1/32 non-participating royalty interest in oil and gas to Samuel Kern, his heirs and assigns. No subsequent conveyance found."),
            new("Estate Note", "2011-02-14", "Robert L. Miller, deceased, intestate", "n/a", "n/a", "Retained 1/4 undivided oil and gas interest at death. No probate opened in Washington County. Surviving children: John A. Miller, Susan Miller Kline, David R. Miller."),
        ]);

    private readonly MineralOwnership _ownership = new(TractId, 118.42,
    [
        new("John A. Miller and Mary E. Miller, h/w", 0.75, "Deed Book 3456, Page 221 (2004)", "Lease signatories."),
        new("Heirs of Robert L. Miller (John A. Miller, Susan Miller Kline, David R. Miller)", 0.25, "Intestate succession, unadministered estate (2011)", "Interest not conveyed of record; requires affidavit of heirship or probate before leasing."),
        new("Samuel Kern, heirs and assigns", 0.03125, "Deed Book 1102, Page 77 (1957) - NPRI", "Non-participating royalty; burdens the lessors' royalty. Ratification recommended for pooling."),
    ]);

    private readonly IReadOnlyList<StandardPosition> _standards =
    [
        new("Primary term", "5 years, optional extension up to 3 years", "Acceptable as drafted"),
        new("Royalty rate", "15% to 18% of gross proceeds", "Above 18% requires Land Manager approval"),
        new("Royalty deductions", "Lessee may deduct Lessor's proportionate share of post-production costs", "Cost-free royalty is non-standard; requires Land Manager approval and economics review"),
        new("Shut-in royalty", "$10 per net mineral acre per year, up to 3 consecutive years", "2-year cap is acceptable"),
        new("Pooling", "Units up to 640 acres plus 10% for gas; no consent required within that size", "Consent requirements above 640+10% are standard"),
        new("Depth limitation", "All depths", "Marcellus-only leases require Reservoir Engineering and Land Manager approval; Utica reservation is a material economic concession"),
        new("Pugh clause", "Horizontal Pugh at end of primary term acceptable; vertical Pugh only with depth limitation", "Acceptable when the lease is already depth-limited"),
        new("Continuous development", "No more than 365 days between wells", "180 days is non-standard and operationally difficult; negotiate to 365"),
        new("Surface use", "Surface rights obtained under separate surface use agreement; no-surface-use lease acceptable", "Acceptable"),
        new("Assignment", "Freely assignable; notice to Lessor", "Consent requirements are non-standard unless limited to non-affiliate transfers with reasonableness standard"),
        new("Warranty", "Special warranty limited to the interest leased", "Acceptable"),
        new("Favored nations", "Not accepted", "Non-standard; strike or limit to same tract and 6 months"),
        new("Audit", "Once every 24 months", "Annual audit is acceptable"),
    ];

    private readonly List<LeaseReviewRecord> _reviews = [];
    private readonly List<CurativeTask> _tasks = [];
    private int _nextReview = 1;
    private int _nextTask = 1;

    public LeaseMetadata? Lease(string leaseId) => _leases.GetValueOrDefault(leaseId);

    public IEnumerable<LeaseMetadata> PendingReview() => _leases.Values.Where(l => l.Status == "PendingReview");

    public string? Document(string documentId) => _documents.GetValueOrDefault(documentId);

    public TractTitle? Title(string tractId) => string.Equals(tractId, TractId, StringComparison.OrdinalIgnoreCase) ? _title : null;

    public MineralOwnership? Ownership(string tractId) => string.Equals(tractId, TractId, StringComparison.OrdinalIgnoreCase) ? _ownership : null;

    public IReadOnlyList<StandardPosition> Standards => _standards;

    public LeaseReviewRecord RecordReview(string leaseId, string outcome, string summary, string decidedBy, string? comments)
    {
        _ = Lease(leaseId) ?? throw new KeyNotFoundException($"Lease {leaseId} not found.");
        var record = new LeaseReviewRecord($"REV-{_nextReview++:0000}", leaseId, outcome, summary, decidedBy, comments, DateTimeOffset.UtcNow);
        _reviews.Add(record);
        return record;
    }

    public CurativeTask CreateTask(string leaseId, string category, string description, string instrument, string timing)
    {
        _ = Lease(leaseId) ?? throw new KeyNotFoundException($"Lease {leaseId} not found.");
        var task = new CurativeTask($"CUR-{_nextTask++:0000}", leaseId, category, description, instrument, timing, "Open");
        _tasks.Add(task);
        return task;
    }

    public LeaseMetadata UpdateStatus(string leaseId, string status)
    {
        LeaseMetadata lease = Lease(leaseId) ?? throw new KeyNotFoundException($"Lease {leaseId} not found.");
        LeaseMetadata updated = lease with { Status = status };
        _leases[leaseId] = updated;
        return updated;
    }
}

/// <summary>
/// Land system tools. Read tools need Tools.Read or Tools.Execute (endpoint policy); write tools additionally
/// require Tools.Execute themselves so an analyst-only identity can never record or change status.
/// </summary>
[McpServerToolType]
public sealed class LandTools(LandRepository repository, IHttpContextAccessor httpContextAccessor)
{
    [McpServerTool(Name = "get_lease_metadata", ReadOnly = true)]
    [Description("Returns lease header data: status, tract id, county, state, broker, document id.")]
    public LeaseMetadata GetLeaseMetadata([Description("Lease id, for example L-2026-0142")] string leaseId) =>
        repository.Lease(leaseId) ?? throw new McpException($"Lease '{leaseId}' was not found.");

    [McpServerTool(Name = "list_leases_pending_review", ReadOnly = true)]
    [Description("Lists draft leases waiting for pre-execution review.")]
    public IEnumerable<LeaseMetadata> ListLeasesPendingReview() => repository.PendingReview();

    [McpServerTool(Name = "get_lease_document", ReadOnly = true)]
    [Description("Returns the full text of a lease document from the document library.")]
    public string GetLeaseDocument([Description("Document id from the lease metadata, for example DOC-88213")] string documentId) =>
        repository.Document(documentId) ?? throw new McpException($"Document '{documentId}' was not found.");

    [McpServerTool(Name = "get_tract_title", ReadOnly = true)]
    [Description("Returns the title runsheet for a tract: recorded deeds, leases, mortgages, reservations, and estate notes with examiner remarks.")]
    public TractTitle GetTractTitle([Description("Tract id from the lease metadata, for example T-3391")] string tractId) =>
        repository.Title(tractId) ?? throw new McpException($"Tract '{tractId}' was not found.");

    [McpServerTool(Name = "get_mineral_ownership", ReadOnly = true)]
    [Description("Returns the current mineral and royalty ownership of a tract with decimal interests and vesting instruments.")]
    public MineralOwnership GetMineralOwnership([Description("Tract id, for example T-3391")] string tractId) =>
        repository.Ownership(tractId) ?? throw new McpException($"Tract '{tractId}' was not found.");

    [McpServerTool(Name = "get_lease_form_standards", ReadOnly = true)]
    [Description("Returns the company's standard lease positions and tolerances, provision by provision, for comparing a draft lease.")]
    public IReadOnlyList<StandardPosition> GetLeaseFormStandards() => repository.Standards;

    [McpServerTool(Name = "record_lease_review", Destructive = true)]
    [Description("Records the outcome of a lease review in the land system. Only call after a human has decided.")]
    public LeaseReviewRecord RecordLeaseReview(
        [Description("Lease id")] string leaseId,
        [Description("ApprovedForExecution or ReturnedForRevision")] string outcome,
        [Description("Review summary")] string summary,
        [Description("Identity of the human who decided")] string decidedBy,
        [Description("Approver comments, if any")] string? comments = null)
    {
        RequireExecute();
        return repository.RecordReview(leaseId, outcome, summary, decidedBy, comments);
    }

    [McpServerTool(Name = "create_curative_task", Destructive = true)]
    [Description("Opens a curative title task for a lease. Only call for an approved lease.")]
    public CurativeTask CreateCurativeTask(
        [Description("Lease id")] string leaseId,
        [Description("Curative category, for example Heirship, UnreleasedPriorLease, MortgageSubordination, NpriRatification, NameVariance")] string category,
        [Description("What must be cured")] string description,
        [Description("Recommended curative instrument")] string recommendedInstrument,
        [Description("BeforeExecution, BeforeDrilling, or PostExecution")] string timing)
    {
        RequireExecute();
        return repository.CreateTask(leaseId, category, description, recommendedInstrument, timing);
    }

    [McpServerTool(Name = "update_lease_status", Destructive = true)]
    [Description("Changes a lease's status, for example to ApprovedForExecution. Only call after a human approved.")]
    public LeaseMetadata UpdateLeaseStatus(
        [Description("Lease id")] string leaseId,
        [Description("New status")] string status,
        [Description("Identity of the human whose decision authorizes the change")] string changedBy)
    {
        RequireExecute();
        return repository.UpdateStatus(leaseId, status);
    }

    private void RequireExecute()
    {
        ClaimsPrincipal? caller = httpContextAccessor.HttpContext?.User;
        if (caller is null || !caller.HasRoleOrScope("Tools.Execute"))
        {
            throw new McpException("The caller is not authorized to change land records (requires the Tools.Execute app role or scope).");
        }
    }
}
