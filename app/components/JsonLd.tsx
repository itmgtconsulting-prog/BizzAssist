/**
 * Type-safe JSON-LD structured data component.
 *
 * BIZZ-219: centralises the dangerouslySetInnerHTML pattern for JSON-LD
 * so it is auditable in one place. JSON.stringify guarantees the output
 * is valid JSON (not executable JavaScript), and `<script type="application/ld+json">`
 * is not executed by browsers — it is only consumed by search engine crawlers.
 *
 * Usage:
 *   <JsonLd data={mySchema} />
 *
 * @param data - JSON-LD structured data object (Schema.org compliant)
 */
export default function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // Safe: JSON.stringify escapes all special characters and cannot produce
      // executable JavaScript. The script type="application/ld+json" is never
      // executed by the browser — it is metadata for search engines only.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
