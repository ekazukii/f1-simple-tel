import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom'
import './App.css'
import SessionExplorer from './pages/SessionExplorer'
import RaceReplayer from './pages/RaceReplayer'

function App() {
  return (
    <BrowserRouter>
      <div className="app-shell">
        <nav className="app-nav">
          <div className="app-nav__brand">
            <span className="eyebrow">F1 telemetry</span>
            <strong>Session Studio</strong>
          </div>
          <div className="app-nav__links">
            <NavLink to="/" end className={({ isActive }) => (isActive ? 'app-nav__link app-nav__link--active' : 'app-nav__link')}>
              Session Explorer
            </NavLink>
            <NavLink
              to="/replayer"
              className={({ isActive }) => (isActive ? 'app-nav__link app-nav__link--active' : 'app-nav__link')}
            >
              Race Replayer
            </NavLink>
          </div>
        </nav>
        <div className="app-shell__content">
          <Routes>
            <Route path="/" element={<SessionExplorer />} />
            <Route path="/replayer" element={<RaceReplayer />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  )
}

export default App
