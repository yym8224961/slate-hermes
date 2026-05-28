import { useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { RequireAuth } from '@/components/layout/RequireAuth';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { LoginPage } from '@/pages/auth/LoginPage';
import { RegisterPage } from '@/pages/auth/RegisterPage';
import { DashboardPage } from '@/pages/dashboard/DashboardPage';
import { GroupDetailPage } from '@/pages/groups/GroupDetailPage';
import { ImageContentEditorPage } from '@/pages/contents/ImageContentEditorPage';
import { DynamicContentEditorPage } from '@/pages/contents/DynamicContentEditorPage';
import { ContentNewPage } from '@/pages/contents/ContentNewPage';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    // 当前路由没有 hash 锚点导航，只在页面路径切换时回到顶部。
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <ErrorBoundary>
      <ScrollToTop />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />

        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<DashboardPage />} />
          <Route path="/devices/:did" element={<DashboardPage />} />
          <Route path="/groups/:gid" element={<GroupDetailPage />} />
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
    </ErrorBoundary>
  );
}
