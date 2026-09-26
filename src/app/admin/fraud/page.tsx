import { redirect } from 'next/navigation';

/**
 * Server redirect wrapper ensuring direct requests to /admin/fraud
 * resolve cleanly to the localized route.
 */
export default function AdminFraudRedirect() {
  redirect('/en/admin/fraud');
}
