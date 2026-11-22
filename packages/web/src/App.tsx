import { Scene } from './scene/Scene.tsx';
import { useStore } from './store.ts';
import { Feed, HubPanel, Legend, ListView, SidePanel, Timeline, TopBar } from './ui/panels.tsx';

export function App() {
  const view = useStore((s) => s.view);
  const selected = useStore((s) => s.selected);
  return (
    <div className={`app ${selected ? 'has-side' : ''}`}>
      <TopBar />
      {view === '3d' ? (
        <>
          <div className="stage">
            <Scene />
          </div>
          <Feed />
          <div className="bottom">
            <Legend />
            <Timeline />
          </div>
        </>
      ) : (
        <ListView />
      )}
      <SidePanel />
      <HubPanel />
    </div>
  );
}
