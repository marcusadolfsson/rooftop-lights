import { NavLink, useLocation } from 'react-router-dom';
import { useConnectionStatus } from './hooks/useLightSocket';
import LayoutPage from './pages/LayoutPage';
import DesignPage from './pages/DesignPage';
import SchedulerPage from './pages/SchedulerPage';
import { OutputMiniButton, OutputPanel, useOutputMonitor } from './components/OutputMonitor';

// Own component so status updates (dmxRate) don't re-render the pages.
// Green: app connected and the ArtNet node answers ArtPoll. Red: either one is down.
function ConnectionIndicator() {
  const { connected, dmxRate, nodeOnline, nodeName } = useConnectionStatus();
  const dot = !connected || nodeOnline === false ? 'disconnected' : nodeOnline ? 'connected' : 'checking';
  const title = !connected ? 'No connection to the server'
    : nodeOnline === false ? `ArtNet node ${nodeName ?? ''} is not answering ArtPoll; still sending ${dmxRate} DMX pkt/s`
    : nodeOnline ? `ArtNet node ${nodeName ?? ''} online, sending ${dmxRate} DMX pkt/s`
    : `Checking ArtNet node; sending ${dmxRate} DMX pkt/s`;
  return (
    <div className="status-indicator" title={title}>
      <span className={`status-dot ${dot}`} />
      {connected && nodeName && <span className="status-node">{nodeOnline === false ? `${nodeName} offline` : nodeName}</span>}
      <span>{connected ? `DMX ${dmxRate} pkt/s` : 'Disconnected'}</span>
    </div>
  );
}

function App() {
  const location = useLocation();
  const monitor = useOutputMonitor();

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-content">
          <div className="nav-brand">Rooftop Lights</div>
          <div className="nav-links">
            <NavLink
              to="/"
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              Design
            </NavLink>
            <NavLink
              to="/schedule"
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              Schedule
            </NavLink>
            <NavLink
              to="/layout"
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
            >
              Light Layout
            </NavLink>
          </div>
          <div className="nav-status">
            <OutputMiniButton monitor={monitor} />
            <ConnectionIndicator />
          </div>
        </div>
        <OutputPanel monitor={monitor} />
      </nav>

      <main className="main-content">
        <div style={{ display: location.pathname === '/' ? 'block' : 'none' }}>
          <DesignPage />
        </div>
        <div style={{ display: location.pathname === '/schedule' ? 'block' : 'none' }}>
          <SchedulerPage />
        </div>
        <div style={{ display: location.pathname === '/layout' ? 'block' : 'none' }}>
          <LayoutPage />
        </div>
      </main>
    </div>
  );
}

export default App;
