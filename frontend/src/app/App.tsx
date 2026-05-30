import { lazy, Suspense, useEffect } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { RequireAuth } from '@/components/layout/RequireAuth';
import { ErrorBoundary } from '@/components/feedback/ErrorBoundary';
import { Spinner } from '@/components/ui/Spinner';
import { appRoutes, routePaths } from './routes';

const LoginPage = lazy(() =>
  import('@/pages/auth/LoginPage').then((module) => ({ default: module.LoginPage }))
);
const RegisterPage = lazy(() =>
  import('@/pages/auth/RegisterPage').then((module) => ({ default: module.RegisterPage }))
);
const DashboardPage = lazy(() =>
  import('@/pages/dashboard/DashboardPage').then((module) => ({ default: module.DashboardPage }))
);
const GroupDetailPage = lazy(() =>
  import('@/pages/groups/GroupDetailPage').then((module) => ({ default: module.GroupDetailPage }))
);
const ContentNewPage = lazy(() =>
  import('@/pages/contents/ContentNewPage').then((module) => ({ default: module.ContentNewPage }))
);
const ImageContentEditorPage = lazy(() =>
  import('@/pages/contents/ImageContentEditorPage').then((module) => ({
    default: module.ImageContentEditorPage,
  }))
);
const DynamicContentEditorPage = lazy(() =>
  import('@/pages/contents/DynamicContentEditorPage').then((module) => ({
    default: module.DynamicContentEditorPage,
  }))
);

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
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path={routePaths.login} element={<LoginPage />} />
          <Route path={routePaths.register} element={<RegisterPage />} />

          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path={routePaths.deviceDetail} element={<DashboardPage />} />
            <Route path={routePaths.groupDetail} element={<GroupDetailPage />} />
            <Route path={routePaths.contentNew} element={<ContentNewPage />} />
            <Route path={routePaths.imageContentEdit} element={<ImageContentEditorPage />} />
            <Route path={routePaths.dynamicContentEdit} element={<DynamicContentEditorPage />} />
          </Route>

          <Route path="*" element={<Navigate to={appRoutes.home} replace />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

function RouteFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Spinner label="加载中" />
    </div>
  );
}
