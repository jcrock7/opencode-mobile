using System.IO.Packaging;
using System.Text;
using System.Xml;
using UglyToad.PdfPig;

namespace AgentWorkflow.Core.Intake;

/// <summary>
/// Extracts plain text from the formats brokers send. Text is what the analyst agent reads through
/// <c>get_lease_document</c>; the original bytes are kept alongside for the record.
/// Scanned PDFs with no text layer come back empty; route those to OCR (Azure Document Intelligence) before intake.
/// </summary>
public static class DocumentTextExtractor
{
    public static string Extract(string fileName, byte[] content)
    {
        string ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".txt" => Encoding.UTF8.GetString(content),
            ".pdf" => ExtractPdf(content),
            ".docx" => ExtractDocx(content),
            _ => throw new NotSupportedException($"Cannot extract text from '{ext}' files."),
        };
    }

    private static string ExtractPdf(byte[] content)
    {
        var sb = new StringBuilder();
        using PdfDocument pdf = PdfDocument.Open(content);
        foreach (UglyToad.PdfPig.Content.Page page in pdf.GetPages())
        {
            sb.AppendLine(page.Text);
            sb.AppendLine();
        }

        return sb.ToString();
    }

    private static string ExtractDocx(byte[] content)
    {
        using var stream = new MemoryStream(content);
        using Package package = Package.Open(stream, FileMode.Open, FileAccess.Read);
        var partUri = new Uri("/word/document.xml", UriKind.Relative);
        if (!package.PartExists(partUri))
        {
            return string.Empty;
        }

        var doc = new XmlDocument();
        using (Stream part = package.GetPart(partUri).GetStream())
        {
            doc.Load(part);
        }

        var ns = new XmlNamespaceManager(doc.NameTable);
        ns.AddNamespace("w", "http://schemas.openxmlformats.org/wordprocessingml/2006/main");

        var sb = new StringBuilder();
        foreach (XmlNode paragraph in doc.SelectNodes("//w:p", ns)!)
        {
            foreach (XmlNode text in paragraph.SelectNodes(".//w:t", ns)!)
            {
                sb.Append(text.InnerText);
            }

            sb.AppendLine();
        }

        return sb.ToString();
    }
}
