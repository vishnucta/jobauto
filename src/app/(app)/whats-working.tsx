import { bestRow, ENOUGH_SENT, type Insights } from "@/lib/insights";

const card = "flex flex-col rounded-panel border border-line-card bg-card";

/**
 * "What's working" (jobauto fork): how often sent applications moved on,
 * by where the job was found, agency or employer, language, the German the
 * posting asked for and the resume's theme, so the next ones go where
 * answers come from. Every sent application counts, whatever the period.
 */
export function WhatsWorking({ insights }: { insights: Insights }) {
  const { sent, replies, early, groups } = insights;
  return (
    <section aria-labelledby="working-heading" className={`${card} col-span-full gap-5 p-7`}>
      <div className="flex flex-col gap-1">
        <h2 id="working-heading" className="font-serif text-section">
          What&apos;s working
        </h2>
        <p className="text-control text-muted">
          Of {sent} sent, {replies} moved on to a screening or further.
          {early && ` With fewer than ${ENOUGH_SENT} sent, the differences below are hints, not answers yet.`}
        </p>
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-muted">Once your applications differ in where you found them, their language or how you sent them, this shows which get answers.</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,300px),1fr))] gap-x-8 gap-y-6">
          {groups.map((group) => {
            const best = bestRow(group);
            return (
              <div key={group.id} className="flex flex-col gap-2">
                <h3 className="text-[15px] font-medium">{group.title}</h3>
                <table className="w-full text-sm">
                  <thead className="sr-only">
                    <tr>
                      <th>Kind</th>
                      <th>Sent</th>
                      <th>Moved on</th>
                      <th>Reply rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row) => (
                      <tr key={row.label} className="border-t border-line">
                        <td className="py-1.5 pr-3">{row.label}</td>
                        <td className="py-1.5 pr-3 text-right text-muted tabular-nums">{row.sent} sent</td>
                        <td className="py-1.5 pr-3 text-right text-muted tabular-nums">{row.replies} moved on</td>
                        <td className="py-1.5 text-right font-medium tabular-nums">{row.rate}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {best && <p className="text-meta text-muted">{best.label} gets the most answers so far.</p>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
