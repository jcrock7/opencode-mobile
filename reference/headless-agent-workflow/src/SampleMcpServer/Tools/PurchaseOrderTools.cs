using System.ComponentModel;
using System.Security.Claims;
using ModelContextProtocol;
using ModelContextProtocol.Server;

namespace SampleMcpServer.Tools;

public sealed record PurchaseOrder(string Id, string Vendor, decimal Amount, string Currency, string Status, string? HoldReason);

public sealed record VendorProfile(string Name, string RiskRating, bool BankDetailsChangedRecently, DateOnly? BankChangeVerifiedOn, int OpenInvoices);

/// <summary>In-memory stand-in for the ERP. Replace with your real system-of-record client.</summary>
public sealed class PurchaseOrderRepository
{
    private readonly Dictionary<string, PurchaseOrder> _orders = new(StringComparer.OrdinalIgnoreCase)
    {
        ["PO-1001"] = new("PO-1001", "Contoso Valves", 48_250m, "USD", "OnHold", "BANK_CHANGE"),
        ["PO-1002"] = new("PO-1002", "Fabrikam Compression", 312_000m, "USD", "OnHold", "OVER_BUDGET"),
        ["PO-1003"] = new("PO-1003", "Northwind Pipe", 9_800m, "USD", "Approved", null),
    };

    private readonly Dictionary<string, VendorProfile> _vendors = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Contoso Valves"] = new("Contoso Valves", "Low", true, new DateOnly(2026, 9, 1), 2),
        ["Fabrikam Compression"] = new("Fabrikam Compression", "Medium", false, null, 7),
        ["Northwind Pipe"] = new("Northwind Pipe", "Low", false, null, 1),
    };

    public PurchaseOrder? Get(string id) => _orders.GetValueOrDefault(id);

    public IEnumerable<PurchaseOrder> OnHold() => _orders.Values.Where(o => o.Status == "OnHold");

    public VendorProfile? Vendor(string name) => _vendors.GetValueOrDefault(name);

    public PurchaseOrder ReleaseHold(string id, string releasedBy)
    {
        PurchaseOrder order = Get(id) ?? throw new KeyNotFoundException($"Purchase order {id} not found.");
        PurchaseOrder released = order with { Status = "Released", HoldReason = null };
        _orders[id] = released;
        return released;
    }
}

/// <summary>
/// Tools exposed to agents. Read tools need Tools.Read or Tools.Execute (enforced at the endpoint);
/// the write tool additionally checks for Tools.Execute itself, showing per-tool authorization.
/// </summary>
[McpServerToolType]
public sealed class PurchaseOrderTools(PurchaseOrderRepository repository, IHttpContextAccessor httpContextAccessor)
{
    [McpServerTool(Name = "get_purchase_order", ReadOnly = true)]
    [Description("Returns a purchase order by id, including its status and hold reason if any.")]
    public PurchaseOrder GetPurchaseOrder([Description("Purchase order id, for example PO-1001")] string purchaseOrderId) =>
        repository.Get(purchaseOrderId) ?? throw new McpException($"Purchase order '{purchaseOrderId}' was not found.");

    [McpServerTool(Name = "list_held_purchase_orders", ReadOnly = true)]
    [Description("Lists purchase orders that are currently on payment hold.")]
    public IEnumerable<PurchaseOrder> ListHeldPurchaseOrders() => repository.OnHold();

    [McpServerTool(Name = "get_vendor_profile", ReadOnly = true)]
    [Description("Returns the vendor master profile: risk rating, recent bank detail changes and whether they were verified, open invoice count.")]
    public VendorProfile GetVendorProfile([Description("Exact vendor name as it appears on the purchase order")] string vendorName) =>
        repository.Vendor(vendorName) ?? throw new McpException($"Vendor '{vendorName}' was not found.");

    [McpServerTool(Name = "release_purchase_order_hold", Destructive = true)]
    [Description("Releases the payment hold on a purchase order. Only call this after a human has approved the release.")]
    public PurchaseOrder ReleasePurchaseOrderHold(
        [Description("Purchase order id to release")] string purchaseOrderId,
        [Description("Name or id of the human who approved the release")] string approvedBy)
    {
        ClaimsPrincipal? caller = httpContextAccessor.HttpContext?.User;
        if (caller is null || !caller.HasRoleOrScope("Tools.Execute"))
        {
            throw new McpException("The caller is not authorized to release holds (requires the Tools.Execute app role or scope).");
        }

        return repository.ReleaseHold(purchaseOrderId, approvedBy);
    }
}
