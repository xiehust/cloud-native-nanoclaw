import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './lib/auth';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import BotDetail from './pages/BotDetail';
import ChannelSetup from './pages/ChannelSetup';
import Messages from './pages/Messages';
import Tasks from './pages/Tasks';
import Layout from './components/Layout';

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="flex items-center justify-center h-screen"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" /></div>;
  }

  if (!user) {
    return <Login />;
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/bots/:botId" element={<BotDetail />} />
        <Route path="/bots/:botId/channels/new" element={<ChannelSetup />} />
        <Route path="/bots/:botId/messages/:groupJid" element={<Messages />} />
        <Route path="/bots/:botId/tasks" element={<Tasks />} />
        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Layout>
  );
}
