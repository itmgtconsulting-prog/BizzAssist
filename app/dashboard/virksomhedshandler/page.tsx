/**
 * Legacy redirect for virksomhedshandler.
 * BIZZ-1929: UI moved to /dashboard/analyse/virksomhedshandler.
 */

import { redirect } from 'next/navigation';

export default function VirksomhedshandlerRedirect() {
  redirect('/dashboard/analyse/virksomhedshandler');
}
