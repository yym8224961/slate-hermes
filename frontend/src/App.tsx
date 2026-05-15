import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { Login } from './routes/Login';
import { Register } from './routes/Register';
import { Dashboard } from './routes/Dashboard';
import { GroupDetail } from './routes/GroupDetail';
import { ImageContentEditorPage } from './routes/ImageContentEditorPage';
import { DynamicContentEditorPage } from './routes/DynamicContentEditorPage';
import { ContentNewPage } from './routes/ContentNewPage';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <>
      <ScrollToTop />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />

        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="/devices/:did" element={<Dashboard />} />
          <Route path="/groups/:gid" element={<GroupDetail />} />
          <Route path="/groups/:gid/contents/new" element={<ContentNewPage />} />
          <Route path="/groups/:gid/contents/image/new" element={<ImageContentEditorPage />} />
          <Route
            path="/groups/:gid/contents/image/:contentId/edit"
            element={<ImageContentEditorPage />}
          />
          <Route path="/groups/:gid/contents/dynamic/new" element={<DynamicContentEditorPage />} />
          <Route
            path="/groups/:gid/contents/dynamic/:contentId/edit"
            element={<DynamicContentEditorPage />}
          />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
