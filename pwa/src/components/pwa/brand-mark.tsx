/** Pi Reach「桥」标识：单色几何 π，颜色跟随 currentColor。 */
export function BrandMark({ size = 24, className }: { size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <path fill="currentColor" d="M13 17h31c3 0 5 2 5 5v4H13c-1.1 0-2-.9-2-2v-5c0-1.1.9-2 2-2Z" />
    <path fill="currentColor" d="M17 26h8v22c0 1.1-.9 2-2 2h-4c-1.1 0-2-.9-2-2V26Z" />
    <path fill="currentColor" d="M40 26h8v17c0 5 2 6 7 5v7c-10 2-15-2-15-11V26Z" />
  </svg>;
}
