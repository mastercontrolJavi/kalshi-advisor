import type {IChartApi,ISeriesApi,ISeriesPrimitive,IPrimitivePaneRenderer,IPrimitivePaneView,UTCTimestamp} from 'lightweight-charts';
import type {priceProjection} from '@/engine/quant/price-forecast';

/** Draw only the estimated future envelope. Native line series provide its time points and price autoscale. */
export class PriceProjectionBand implements ISeriesPrimitive {
  private points:ReturnType<typeof priceProjection>=[];private redraw:(()=>void)|null=null;
  private renderer:IPrimitivePaneRenderer={draw:target=>target.useMediaCoordinateSpace(({context:ctx})=>{
    const points=this.points.map(p=>({x:this.chart.timeScale().timeToCoordinate(p.time as UTCTimestamp),low:this.series.priceToCoordinate(p.low),high:this.series.priceToCoordinate(p.high)})).filter((p):p is {x:NonNullable<typeof p.x>;low:NonNullable<typeof p.low>;high:NonNullable<typeof p.high>}=>p.x!==null&&p.low!==null&&p.high!==null);
    if(points.length<2)return;ctx.save();ctx.beginPath();ctx.moveTo(points[0].x,points[0].high);for(const p of points.slice(1))ctx.lineTo(p.x,p.high);for(const p of [...points].reverse())ctx.lineTo(p.x,p.low);ctx.closePath();ctx.fillStyle='rgba(154,168,255,0.14)';ctx.fill();ctx.restore();
  })};
  private views:IPrimitivePaneView[]=[{zOrder:()=> 'bottom',renderer:()=>this.renderer}];
  constructor(private chart:IChartApi,private series:ISeriesApi<'Line'>){}
  attached({requestUpdate}:Parameters<NonNullable<ISeriesPrimitive['attached']>>[0]){this.redraw=requestUpdate;}
  detached(){this.redraw=null;}
  paneViews(){return this.views;}
  setData(points:ReturnType<typeof priceProjection>){this.points=points;this.redraw?.();}
}
