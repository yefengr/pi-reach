/** 端口只暴露数字与存活状态；DOM 节点由布局适配器缓存和验证。 */
export type ReplyProbe = { sample(): { height: number; streaming: boolean } | null };
type Geometry = { height: number; bottom: number; compensation: number };
const EPSILON = 1;

/** 仅延续发送时已在显示的回复，不把其他行或视口变化归因于旧 partial。 */
export class ReplyContinuity {
  private rowHeight = 0;
  private contentHeight = 0;
  private viewport = 0;
  private streaming = true;

  constructor(private readonly probe: ReplyProbe, geometry: Geometry) {
    this.update(geometry, true);
  }

  /** 尺寸过程拥有 footer 变化；释放后每次净内容变化都必须由追踪行高度解释。 */
  update(geometry: Geometry, sizing = false): boolean {
    const row = this.probe.sample();
    if (!row) return false;
    const content = geometry.height - geometry.compensation;
    const viewport = geometry.height - geometry.bottom;
    const valid = sizing || (Math.abs(viewport - this.viewport) <= EPSILON
      && Math.abs((content - this.contentHeight) - (row.height - this.rowHeight)) <= EPSILON);
    this.rowHeight = row.height;
    this.contentHeight = content;
    this.viewport = viewport;
    this.streaming = row.streaming;
    return valid;
  }

  retain(moving: boolean): boolean { return moving || this.streaming; }
}
