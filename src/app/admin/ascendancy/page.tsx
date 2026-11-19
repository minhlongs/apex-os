import { redirect } from 'next/navigation';

/**
 * Server redirect wrapper ensuring direct requests to /admin/ascendancy
 * resolve cleanly in a single hop to the unified Treasury & Ascendancy Console.
 */
export default function AdminAscendancyRedirect() {
  redirect('/en/admin/treasury');
}
