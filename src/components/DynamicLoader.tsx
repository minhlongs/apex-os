'use client';

import { Suspense, lazy, type ReactNode, type ComponentType } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Dynamic component wrapper with loading state
 *
 * Usage:
 * ```tsx
 * const HeavyComponent = dynamic(() => import('@/components/HeavyComponent'), {
 *   ssr: false,
 *   loading: () => <DynamicLoading />
 * });
 * ```
 */

interface DynamicLoadingProps {
  /** Custom loading message */
  message?: string;
  /** Size of loader: 'sm' | 'md' | 'lg' */
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Default loading spinner for dynamic components
 */
export function DynamicLoading({ message = 'Loading...', size = 'md' }: DynamicLoadingProps) {
  const sizeClasses = {
    sm: 'w-4 h-4',
    md: 'w-8 h-8',
    lg: 'w-12 h-12',
  };

  return (
    <div className="flex items-center justify-center py-8">
      <Loader2 className={`${sizeClasses[size]} animate-spin text-blue-600`} />
      {message && <span className="ml-3 text-gray-600">{message}</span>}
    </div>
  );
}

/**
 * Skeleton loader for card-like containers
 */
export function CardSkeleton() {
  return (
    <div className="border rounded-lg p-6">
      <div className="animate-pulse space-y-3">
        <div className="h-4 bg-gray-200 rounded w-1/2"></div>
        <div className="h-8 bg-gray-200 rounded w-3/4"></div>
        <div className="h-4 bg-gray-200 rounded w-1/3"></div>
      </div>
    </div>
  );
}

/**
 * Table skeleton loader
 */
export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="bg-gray-50 h-12 animate-pulse"></div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-12 bg-white animate-pulse">
            <div className="flex items-center px-4 space-x-4">
              <div className="h-4 bg-gray-200 rounded w-full"></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Higher-order component for lazy loading with default Suspense boundary
 */
export function createDynamicImport<T extends ComponentType<any>>(
  importFn: () => Promise<{ default: T }>,
  options: {
    ssr?: boolean;
    loadingComponent?: ReactNode;
  } = {}
) {
  const LazyComponent = lazy(importFn);

  return function DynamicComponent(props: React.ComponentProps<T>) {
    const { loadingComponent, ssr = false } = options;

    return (
      <Suspense fallback={loadingComponent || <DynamicLoading />}>
        {/* @ts-ignore - LazyComponent type inference */}
        <LazyComponent {...props} />
      </Suspense>
    );
  };
}
