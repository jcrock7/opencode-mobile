using System.Text.RegularExpressions;

namespace AgentWorkflow.Core.Intake;

/// <summary>
/// Turns a broker's email into intake fields. Deliberately simple and deterministic (no model call): the
/// sender must be an allowed broker domain, exactly one acceptable lease attachment is chosen, and
/// "Key: value" lines in the body (or the subject convention) fill the optional metadata. Anything the
/// parser cannot find is left for the analyst agent to read from the lease itself.
/// </summary>
public static partial class LeaseEmailParser
{
    // Subject convention brokers are asked to follow: "Lease submission: <Lessor> - <County> County, <ST>"
    [GeneratedRegex(@"^\s*lease\s+submission\s*[:\-]\s*(?<lessor>.+?)\s*[-–]\s*(?<county>[A-Za-z .'\-]+?)\s+county,?\s*(?<state>[A-Za-z]{2})\b", RegexOptions.IgnoreCase)]
    private static partial Regex SubjectPattern();

    [GeneratedRegex(@"^\s*(?<key>[A-Za-z][A-Za-z /]{1,30}?)\s*:\s*(?<value>.+?)\s*$", RegexOptions.Multiline)]
    private static partial Regex KeyValueLine();

    public static IntakeParseResult Parse(InboundMessage message, EmailIntakeOptions options)
    {
        string domain = DomainOf(message.FromAddress);
        string firm = options.BrokerFirms.TryGetValue(domain, out string? name) ? name : domain;

        if (options.AllowedSenderDomains.Count > 0
            && !options.AllowedSenderDomains.Any(d => string.Equals(d.TrimStart('@'), domain, StringComparison.OrdinalIgnoreCase)))
        {
            return Reject($"Sender domain '{domain}' is not an allowed broker.", firm);
        }

        InboundAttachment? lease = ChooseLeaseAttachment(message.Attachments, options);
        if (lease is null)
        {
            return Reject("No acceptable lease attachment (.pdf, .docx, .txt under the size limit).", firm);
        }

        var fields = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (Match m in KeyValueLine().Matches(message.BodyText))
        {
            string key = Normalize(m.Groups["key"].Value);
            fields.TryAdd(key, m.Groups["value"].Value.Trim());
        }

        Match subject = SubjectPattern().Match(message.Subject);
        string? lessor = Get(fields, "lessor", "lessors", "lessor name") ?? (subject.Success ? subject.Groups["lessor"].Value.Trim() : null);
        string? county = Get(fields, "county") ?? (subject.Success ? subject.Groups["county"].Value.Trim() : null);
        string? state = Get(fields, "state", "st") ?? (subject.Success ? subject.Groups["state"].Value.ToUpperInvariant() : null);
        string? tract = Get(fields, "tract", "tract id", "tract number", "parcel", "tax parcel");
        string? acres = Get(fields, "gross acres", "acres", "acreage");

        if (county is not null && county.EndsWith(" county", StringComparison.OrdinalIgnoreCase))
        {
            county = county[..^7].Trim();
        }

        return new IntakeParseResult(true, null, firm, lessor, county, state?.ToUpperInvariant(), tract, acres, lease);
    }

    /// <summary>Prefers an attachment whose name mentions "lease"; otherwise the largest acceptable one.</summary>
    public static InboundAttachment? ChooseLeaseAttachment(IReadOnlyList<InboundAttachment> attachments, EmailIntakeOptions options)
    {
        var acceptable = attachments
            .Where(a => options.AllowedAttachmentExtensions.Contains(Path.GetExtension(a.Name), StringComparer.OrdinalIgnoreCase))
            .Where(a => a.Size > 0 && a.Size <= options.MaxAttachmentBytes)
            .ToList();

        return acceptable.FirstOrDefault(a => a.Name.Contains("lease", StringComparison.OrdinalIgnoreCase))
            ?? acceptable.OrderByDescending(a => a.Size).FirstOrDefault();
    }

    public static string DomainOf(string address)
    {
        int at = address.LastIndexOf('@');
        return at < 0 ? address.Trim().ToLowerInvariant() : address[(at + 1)..].Trim().TrimEnd('>').ToLowerInvariant();
    }

    private static IntakeParseResult Reject(string reason, string firm) => new(false, reason, firm, null, null, null, null, null, null);

    private static string Normalize(string key) => string.Join(' ', key.Trim().ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries));

    private static string? Get(Dictionary<string, string> fields, params string[] keys)
    {
        foreach (string key in keys)
        {
            if (fields.TryGetValue(key, out string? value) && !string.IsNullOrWhiteSpace(value))
            {
                return value;
            }
        }

        return null;
    }
}
