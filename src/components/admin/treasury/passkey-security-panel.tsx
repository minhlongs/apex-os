'use client';

/**
 * Admin WebAuthn Hardware/Platform Passkey (`ES256`) Enrollment & Step-Up Panel
 *
 * Connects to:
 * - GET  /api/admin/passkey -> List enrolled admin FIDO2/WebAuthn credentials
 * - POST /api/admin/passkey -> `enrollAdminPasskey` (`ES256`) & `obtainAdminStepUpToken` (5-min TTL)
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertOctagon,
  CheckCircle,
  Clock,
  Key,
  Lock,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import {
  enrollAdminPasskey,
  isBrowserWebAuthnSupported,
  obtainAdminStepUpToken,
} from '@/lib/auth/webauthn-browser';

export interface EnrolledAdminPasskey {
  credential_id: string;
  device_name: string | null;
  counter: number;
  created_at: string;
  last_used_at: string | null;
}

export interface ActivePasskeyStepUpSession {
  stepUpToken: string;
  expiresAt: string;
}

interface PasskeyListApiResponse {
  success: boolean;
  credentials?: EnrolledAdminPasskey[];
  error?: string;
}

export interface PasskeySecurityPanelProps {
  activeStepUp: ActivePasskeyStepUpSession | null;
  onStepUpChange: (session: ActivePasskeyStepUpSession | null) => void;
}

function formatCountdown(remainingSeconds: number): string {
  const safeSeconds = Math.max(0, remainingSeconds);
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function truncateCredentialId(id: string): string {
  if (id.length <= 18) {
    return id;
  }
  return `${id.slice(0, 10)}...${id.slice(-6)}`;
}

export function PasskeySecurityPanel({
  activeStepUp,
  onStepUpChange,
}: PasskeySecurityPanelProps) {
  const [credentials, setCredentials] = useState<EnrolledAdminPasskey[]>([]);
  const [loadingList, setLoadingList] = useState<boolean>(true);
  const [enrolling, setEnrolling] = useState<boolean>(false);
  const [verifyingStepUp, setVerifyingStepUp] = useState<boolean>(false);
  const [deviceName, setDeviceName] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState<number>(0);
  const [webAuthnSupported, setWebAuthnSupported] = useState<boolean>(true);

  useEffect(() => {
    setWebAuthnSupported(isBrowserWebAuthnSupported());
  }, []);

  const fetchCredentials = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/passkey', {
        method: 'GET',
        credentials: 'same-origin',
      });
      const json = (await res.json()) as PasskeyListApiResponse;
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to load enrolled Passkeys.');
      }
      setCredentials(json.credentials ?? []);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Unable to fetch enrolled Passkeys.'
      );
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    void fetchCredentials();
  }, [fetchCredentials]);

  useEffect(() => {
    if (!activeStepUp) {
      setRemainingSeconds(0);
      return;
    }

    const computeRemaining = (): number => {
      const expiresMs = Date.parse(activeStepUp.expiresAt);
      if (Number.isNaN(expiresMs)) {
        return 0;
      }
      return Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
    };

    const initial = computeRemaining();
    setRemainingSeconds(initial);
    if (initial <= 0) {
      onStepUpChange(null);
      return;
    }

    const timer = globalThis.setInterval(() => {
      const next = computeRemaining();
      setRemainingSeconds(next);
      if (next <= 0) {
        globalThis.clearInterval(timer);
        onStepUpChange(null);
      }
    }, 1000);

    return () => {
      globalThis.clearInterval(timer);
    };
  }, [activeStepUp, onStepUpChange]);

  const handleEnrollPasskey = async () => {
    setEnrolling(true);
    setError(null);
    setStatusBanner(null);
    try {
      const label = deviceName.trim() || undefined;
      const enrolled = await enrollAdminPasskey(label);
      setDeviceName('');
      setStatusBanner(
        `Enrolled ES256 Passkey (${truncateCredentialId(enrolled.credentialId)}).`
      );
      await fetchCredentials();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Passkey enrollment failed.'
      );
    } finally {
      setEnrolling(false);
    }
  };

  const handleVerifyStepUp = async () => {
    setVerifyingStepUp(true);
    setError(null);
    setStatusBanner(null);
    try {
      const session = await obtainAdminStepUpToken();
      onStepUpChange(session);
      setStatusBanner(
        'Passkey step-up verified. High-risk Admin Console mutations unlocked for 5 minutes.'
      );
      await fetchCredentials();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : 'Passkey step-up verification failed.'
      );
    } finally {
      setVerifyingStepUp(false);
    }
  };

  const isStepUpUnlocked = Boolean(activeStepUp && remainingSeconds > 0);

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-6">
      <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-4">
        <div>
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Key className="w-5 h-5 text-indigo-600" />
            <span>FIDO2 / WebAuthn Passkey Hardware Security (`ES256`)</span>
          </h2>
          <p className="text-xs text-gray-500 mt-1">
            All runtime circuit breakers, partner poll/ingest mutations, and Turnkey/Safe broadcast recoveries require a live single-use Passkey step-up assertion.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {isStepUpUnlocked ? (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold">
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
              <span>Step-Up Unlocked</span>
              <span className="inline-flex items-center gap-1 font-mono bg-emerald-100 px-2 py-0.5 rounded text-emerald-900">
                <Clock className="w-3 h-3" />
                {formatCountdown(remainingSeconds)}
              </span>
              <button
                type="button"
                onClick={() => onStepUpChange(null)}
                className="ml-1 text-emerald-700 underline hover:text-emerald-900"
              >
                Lock
              </button>
            </div>
          ) : (
            <div className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs font-semibold">
              <Lock className="w-3.5 h-3.5 text-amber-600" />
              <span>Step-Up Locked (Assertion Required)</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => void fetchCredentials()}
            disabled={loadingList}
            className="inline-flex items-center px-3 py-1.5 border border-gray-300 rounded-lg text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 mr-1.5 ${loadingList ? 'animate-spin' : ''}`}
            />
            Refresh Keys
          </button>
        </div>
      </div>

      {!webAuthnSupported ? (
        <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
          Browser WebAuthn API (`navigator.credentials`) is unavailable in this context. Use an HTTPS origin or `localhost` with a FIDO2 authenticator.
        </div>
      ) : null}

      {error ? (
        <div className="mb-4 rounded-lg bg-red-50 border border-red-200 p-3 text-xs text-red-700 flex items-center gap-2">
          <AlertOctagon className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {statusBanner ? (
        <div className="mb-4 rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-800 flex items-center gap-2">
          <CheckCircle className="w-4 h-4 shrink-0 text-emerald-600" />
          <span>{statusBanner}</span>
        </div>
      ) : null}

      {/* Enrollment & Step-Up Action Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3 mb-5">
        <div className="lg:col-span-5">
          <label
            htmlFor="passkey-device-name"
            className="sr-only"
          >
            Passkey Device Label
          </label>
          <input
            id="passkey-device-name"
            type="text"
            value={deviceName}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder="Authenticator label (e.g. YubiKey 5C Nano / MacBook Touch ID)"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="lg:col-span-4">
          <button
            type="button"
            onClick={() => void handleEnrollPasskey()}
            disabled={enrolling || !webAuthnSupported}
            className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Key className="w-4 h-4 mr-2" />
            {enrolling
              ? 'Awaiting Authenticator...'
              : 'Enroll Hardware/Platform Passkey (ES256)'}
          </button>
        </div>

        <div className="lg:col-span-3">
          <button
            type="button"
            onClick={() => void handleVerifyStepUp()}
            disabled={
              verifyingStepUp || !webAuthnSupported || credentials.length === 0
            }
            className="w-full inline-flex items-center justify-center px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <ShieldCheck className="w-4 h-4 mr-1.5" />
            {verifyingStepUp
              ? 'Verifying...'
              : 'Verify Passkey Step-Up (5-min session token)'}
          </button>
        </div>
      </div>

      {/* Enrolled Credentials Table */}
      <div className="border-t border-gray-100 pt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
          Enrolled Admin Authenticators ({credentials.length})
        </h3>

        {loadingList ? (
          <p className="text-xs text-gray-500 py-2">
            Loading enrolled WebAuthn credentials...
          </p>
        ) : credentials.length === 0 ? (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            No WebAuthn Passkeys enrolled for this admin profile yet. Enroll a hardware or platform authenticator (`ES256`) above to unlock privileged mutations.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">
                    Device Name
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">
                    Credential ID
                  </th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-600">
                    Sign Counter
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">
                    Enrolled At
                  </th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">
                    Last Step-Up
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {credentials.map((cred) => (
                  <tr key={cred.credential_id}>
                    <td className="px-3 py-2 font-medium text-gray-900">
                      {cred.device_name || 'Admin Security Key'}
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-600">
                      {truncateCredentialId(cred.credential_id)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-gray-700">
                      {cred.counter}
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      {cred.created_at}
                    </td>
                    <td className="px-3 py-2 text-gray-600">
                      {cred.last_used_at || 'Never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
