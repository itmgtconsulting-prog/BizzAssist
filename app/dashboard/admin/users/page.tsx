/**
 * Server entry point for users — forces dynamic rendering (lambda).
 */
import UsersClient from './UsersClient';

export const dynamic = 'force-dynamic';

export default function AdminUsersPage() {
  return <UsersClient />;
}
