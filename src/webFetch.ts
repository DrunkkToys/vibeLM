function stripContentTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "");
}

function htmlToText(html: string): string {
  let s = stripContentTags(html);
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|tr|blockquote|pre|section|article|nav|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, c: string) => String.fromCharCode(+c))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s;
}

export function extractContent(html: string, maxChars: number = 50000): {
  content: string;
  title?: string;
  truncated: boolean;
  originalLength: number;
  extractedLength: number;
} {
  const originalLength = html.length;
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const content = htmlToText(html);
  const truncated = content.length > maxChars;
  return {
    content: truncated ? content.slice(0, maxChars) : content,
    title: titleMatch?.[1]?.trim(),
    truncated,
    originalLength,
    extractedLength: content.length,
  };
}
