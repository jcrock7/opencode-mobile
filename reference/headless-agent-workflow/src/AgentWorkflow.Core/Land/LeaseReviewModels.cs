namespace AgentWorkflow.Core.Land;

/// <summary>
/// Key economic and operational terms a landman captures from an oil and gas lease before execution.
/// Values are strings so the model can quote the lease ("3/16", "$3,500 per net mineral acre",
/// "5 years with one 3-year extension") without lossy normalization; downstream systems normalize.
/// </summary>
public sealed record LeaseKeyTerms(
    IReadOnlyList<string> Lessors,
    string Lessee,
    string LegalDescription,
    string County,
    string State,
    double? GrossAcres,
    double? NetMineralAcres,
    string PrimaryTerm,
    string BonusConsideration,
    string RoyaltyRate,
    string? EffectiveDate,
    string? DelayRental,
    string? ShutInRoyalty,
    string? ExtensionOption,
    string? DepthLimitation,
    string? PughClause,
    string? PoolingProvision,
    string? ContinuousDevelopmentClause,
    string? SurfaceUseProvisions,
    string? RoyaltyDeductions,
    string? AssignmentRestrictions,
    string? WarrantyOfTitle,
    IReadOnlyList<string> OtherNotableTerms);

/// <summary>One lease provision compared with the company's standard lease form and policy.</summary>
/// <param name="Classification">Standard, NonStandard, or Missing.</param>
public sealed record ProvisionFinding(
    string Provision,
    string LeaseLanguage,
    string Classification,
    string Concern,
    string Recommendation);

/// <summary>A title defect or gap that must be cured, and when.</summary>
/// <param name="Category">
/// UnreleasedPriorLease, MortgageSubordination, Heirship, Probate, NpriRatification, NameVariance,
/// LifeEstate, MissingConveyance, TaxLien, UnlocatedOwner, Other.
/// </param>
/// <param name="Timing">BeforeExecution, BeforeDrilling, or PostExecution.</param>
public sealed record CurativeItem(
    string Category,
    string Description,
    string AffectedInterest,
    string Timing,
    string RecommendedInstrument,
    string ResponsibleParty);

/// <summary>
/// The analyst agent's complete lease review. Produced as structured output and carried in
/// <see cref="Models.DecisionRequest.Detail"/> so the card can show it and the record step can act on it.
/// </summary>
/// <param name="TitleStatus">Clean, CurativeRequired, or Defective.</param>
/// <param name="Recommendation">ApproveForExecution, ApproveWithCurative, or ReturnForRevision.</param>
public sealed record LeaseReview(
    string LeaseId,
    LeaseKeyTerms KeyTerms,
    IReadOnlyList<ProvisionFinding> Provisions,
    IReadOnlyList<CurativeItem> CurativeItems,
    string TitleStatus,
    string Recommendation,
    string Summary,
    IReadOnlyList<string> Evidence)
{
    public IEnumerable<ProvisionFinding> NonStandardProvisions =>
        Provisions.Where(p => !string.Equals(p.Classification, "Standard", StringComparison.OrdinalIgnoreCase));

    public IEnumerable<CurativeItem> BlockingCurative =>
        CurativeItems.Where(c => string.Equals(c.Timing, "BeforeExecution", StringComparison.OrdinalIgnoreCase));
}

/// <summary>Structured output of the land operator agent after recording the review in the land system.</summary>
public sealed record LeaseReviewRecordReport(
    bool Succeeded,
    string Summary,
    IReadOnlyList<string> CurativeTaskIds);
