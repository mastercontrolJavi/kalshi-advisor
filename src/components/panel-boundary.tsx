'use client';
import {Component,type ReactNode} from 'react';
import {TriangleAlert} from 'lucide-react';

/** A crash inside one panel (render or effect, e.g. a chart library assertion) shows here instead of blanking the whole page. */
export class PanelBoundary extends Component<{name:string;children:ReactNode},{error:Error|null}>{
  state={error:null as Error|null};
  static getDerivedStateFromError(error:Error){return {error};}
  componentDidCatch(error:Error){console.error(`${this.props.name} crashed`,error);}
  render(){
    const e=this.state.error;if(!e)return this.props.children;
    // A missing chunk means the app was rebuilt while this tab was open; only a reload fetches the new files.
    const stale=/ChunkLoadError|Loading chunk|dynamically imported module/i.test(`${e.name} ${e.message}`);
    return <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-warn/40 bg-warn-dim/30 px-4 py-3 text-sm text-warn">
      <TriangleAlert aria-hidden className="size-4 shrink-0"/>
      <span className="min-w-0 flex-1">{stale?`The app was updated while this page was open, so ${this.props.name.toLowerCase()} could not load.`:`${this.props.name} hit an error: ${e.message}`}</span>
      <button type="button" className="min-h-9 rounded-lg border border-warn/40 px-3 text-fg hover:bg-warn-dim/50" onClick={()=>stale?location.reload():this.setState({error:null})}>{stale?'Reload page':'Retry'}</button>
    </div>;
  }
}
