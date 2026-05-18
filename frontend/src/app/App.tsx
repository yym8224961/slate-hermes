import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { RequireAuth } from '@/components/layout/RequireAuth';
import { Login } from '@/pages/auth/LoginPage';
import { Register } from '@/pages/auth/RegisterPage';
import { Dashboard } from '@/pages/dashboard/DashboardPage';
import { GroupDetail } from '@/pages/groups/GroupDetailPage';
import { ImageContentEditorPage } from '@/pages/contents/ImageContentEditorPage';
import { DynamicContentEditorPage } from '@/pages/contents/DynamicContentEditorPage';
import { ContentNewPage } from '@/pages/contents/ContentNewPage';

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
          <Route
            path="/groups/:gid/contents/image/:contentId/edit"
            element={<ImageContentEditorPage />}
          />
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
