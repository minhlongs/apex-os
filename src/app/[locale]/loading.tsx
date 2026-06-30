export default function Loading() {
  return (
    <div className="min-h-screen bg-background dark:bg-background-darker antialiased">
      <div className="max-w-6xl mx-auto px-4 py-8">
        {/* Header skeleton */}
        <div className="flex items-center justify-between mb-8">
          <div className="h-8 w-48 bg-surface dark:bg-surface-dark rounded-lg animate-pulse" />
          <div className="h-10 w-32 bg-surface dark:bg-surface-dark rounded-lg animate-pulse" />
        </div>

        {/* Cards skeleton */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="bg-white dark:bg-surface-dark rounded-xl p-6 border border-border-subtle dark:border-border"
            >
              <div className="h-5 w-3/4 bg-surface dark:bg-surface-darker rounded animate-pulse mb-4" />
              <div className="h-4 w-1/2 bg-surface dark:bg-surface-darker rounded animate-pulse mb-2" />
              <div className="h-4 w-2/3 bg-surface dark:bg-surface-darker rounded animate-pulse mb-6" />
              <div className="h-10 w-full bg-surface dark:bg-surface-darker rounded-lg animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
