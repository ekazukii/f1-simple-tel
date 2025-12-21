import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import './App.css'
import SessionExplorer from './pages/SessionExplorer'
import RaceReplayer from './pages/RaceReplayer'
import GaragePortal from './pages/GaragePortal'

function AppShell() {
  const location = useLocation()
  const isGarage = location.pathname.startsWith('/garage')

  return (
    <div className="app-shell">
      {!isGarage && (
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
            <NavLink
              to="/garage"
              className={({ isActive }) => (isActive ? 'app-nav__link app-nav__link--active' : 'app-nav__link')}
            >
              Garage Portal
            </NavLink>
          </div>
        </nav>
      )}
      <div className={isGarage ? 'app-shell__content app-shell__content--full' : 'app-shell__content'}>
        <Routes>
          <Route path="/" element={<SessionExplorer />} />
          <Route path="/replayer" element={<RaceReplayer />} />
          <Route path="/garage" element={<GaragePortal />} />
        </Routes>
      </div>
    </div>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  )
}

export default App
