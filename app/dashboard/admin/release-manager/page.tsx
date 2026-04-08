/**
 * Server entry point for release-manager — forces dynamic rendering (lambda).
 */
import ReleaseManagerClient from './ReleaseManagerClient';

export const dynamic = 'force-dynamic';

export default function ReleaseManagerPage() {
  return <ReleaseManagerClient />;
}
