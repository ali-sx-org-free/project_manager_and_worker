import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { connect } from './backend.ts';
import { useStore } from './store.ts';
import './styles.css';

// 方便在瀏覽器控制台查看狀態：__agentPm.getState()
(window as unknown as { __agentPm: typeof useStore }).__agentPm = useStore;

connect();
createRoot(document.getElementById('root')!).render(<App />);
