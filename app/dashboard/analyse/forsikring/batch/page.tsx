/**
 * Batch forsikrings-gap — /dashboard/analyse/forsikring/batch
 *
 * BIZZ-1224: Upload kundeportefølje (CSV) og kør gap-analyse for alle kunder.
 *
 * @module app/dashboard/analyse/forsikring/batch
 */

'use client';

import dynamic from 'next/dynamic';

/** BIZZ-1224: Batch-klient loaded dynamisk (fil-parsing kræver browser) */
const BatchClient = dynamic(() => import('./BatchForsikringClient'), { ssr: false });

/** Batch forsikrings-gap page */
export default function BatchForsikringPage() {
  return <BatchClient />;
}
