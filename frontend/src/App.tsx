import { BrowserRouter, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import appStyles from './styles/AppShell.module.css'
import sharedStyles from './styles/Shared.module.css'
import './styles/base.css'
import SessionExplorer from './pages/SessionExplorer'
import RaceReplayer from './pages/RaceReplayer'
import GaragePortal from './pages/GaragePortal'

function AppShell() {
  const location = useLocation()
  const isGarage = location.pathname.startsWith('/garage')
  const styles = { ...sharedStyles, ...appStyles }
  const cx = (...names: string[]) => names.map((n) => styles[n]).filter(Boolean).join(' ')

  return (
    <div className={cx('app-shell')}>
      {!isGarage && (
        <nav className={cx('app-nav')}>
          <div className={cx('app-nav__brand')}>
            <span className={cx('eyebrow')}>F1 telemetry</span>
            <strong>Session Studio</strong>
          </div>
          <div className={cx('app-nav__links')}>
            <NavLink
              to="/"
              end
              className={({ isActive }) => cx('app-nav__link', isActive ? 'app-nav__link--active' : '')}
            >
              Session Explorer
            </NavLink>
            <NavLink
              to="/replayer"
              className={({ isActive }) => cx('app-nav__link', isActive ? 'app-nav__link--active' : '')}
            >
              Race Replayer
            </NavLink>
            <NavLink
              to="/garage"
              className={({ isActive }) => cx('app-nav__link', isActive ? 'app-nav__link--active' : '')}
            >
              Garage Portal
            </NavLink>
          </div>
        </nav>
      )}
      <div className={isGarage ? cx('app-shell__content', 'app-shell__content--full') : cx('app-shell__content')}>
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
