/**
 * Server entry — forces dynamic rendering (Vercel lambda).
 * Forsikringsmodulets liste-side: viser policer + pending uploads + KPI-tæller.
 */
import ForsikringPageClient from './ForsikringPageClient';

export const dynamic = 'force-dynamic';

export default function ForsikringPage() {
  return <ForsikringPageClient />;
}
