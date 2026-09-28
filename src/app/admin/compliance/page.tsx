import { redirect } from 'next/navigation';

/**
 * Server redirect wrapper ensuring direct requests to /admin/compliance
 * resolve cleanly to the localized route.
 */
export default function AdminComplianceRedirect() {
  redirect('/en/admin/compliance');
}
