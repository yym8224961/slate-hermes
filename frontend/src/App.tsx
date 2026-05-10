// 路由表。
//
// 总览(/)与设备 deep link(/devices/:did)共享 Dashboard:
//   后者只是让 Dashboard 自动打开对应 device modal。
// 已砍:/groups 列表(总览即列表入口)、独立 DeviceDetail。

import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { Login } from './routes/Login';
import { Register } from './routes/Register';
import { Dashboard } from './routes/Dashboard';
import { GroupDetail } from './routes/GroupDetail';

export function App() {
  return (
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
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
