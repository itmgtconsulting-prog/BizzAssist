'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Search,
  MessageSquare,
  Building2,
  Briefcase,
  Users,
  BarChart3,
  Settings,
  LogOut,
  Menu,
  X,
  Bell,
} from 'lucide-react';
import { useLanguage } from '@/app/context/LanguageContext';
import FeedbackButton from '@/app/components/FeedbackButton';

const navItems = [
  { icon: LayoutDashboard, labelDa: 'Oversigt', labelEn: 'Overview', href: '/dashboard' },
  { icon: Search, labelDa: 'Søg', labelEn: 'Search', href: '/dashboard/search' },
  { icon: MessageSquare, labelDa: 'AI Chat', labelEn: 'AI Chat', href: '/dashboard/chat' },
  { icon: Building2, labelDa: 'Ejendomme', labelEn: 'Properties', href: '/dashboard/properties' },
  { icon: Briefcase, labelDa: 'Virksomheder', labelEn: 'Companies', href: '/dashboard/companies' },
  { icon: Users, labelDa: 'Personer', labelEn: 'People', href: '/dashboard/people' },
  { icon: BarChart3, labelDa: 'Analyser', labelEn: 'Analysis', href: '/dashboard/analysis' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { lang, setLang } = useLanguage();
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen bg-[#0a1020] overflow-hidden">
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-30 w-64 bg-[#0f172a] flex flex-col transition-transform duration-300 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        {/* Logo */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/10">
          <Link href="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">B</span>
            </div>
            <span className="text-white font-bold text-lg">
              Bizz<span className="text-blue-400">Assist</span>
            </span>
          </Link>
          <button
            className="lg:hidden text-slate-400 hover:text-white"
            onClick={() => setSidebarOpen(false)}
          >
            <X size={20} />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-4 py-6 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const label = lang === 'da' ? item.labelDa : item.labelEn;
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setSidebarOpen(false)}
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-white hover:bg-white/5'
                }`}
              >
                <Icon size={18} />
                {label}
              </Link>
            );
          })}
        </nav>

        {/* Bottom section */}
        <div className="px-4 pb-6 space-y-1 border-t border-white/10 pt-4">
          <Link
            href="/dashboard/settings"
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-slate-400 hover:text-white hover:bg-white/5 transition-all"
          >
            <Settings size={18} />
            {lang === 'da' ? 'Indstillinger' : 'Settings'}
          </Link>
          <Link
            href="/"
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium text-slate-400 hover:text-white hover:bg-white/5 transition-all"
          >
            <LogOut size={18} />
            {lang === 'da' ? 'Log ud' : 'Log out'}
          </Link>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header className="bg-[#0f172a] border-b border-white/8 px-6 py-4 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-4">
            <button
              className="lg:hidden text-slate-400 hover:text-white"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={22} />
            </button>
            <div className="relative hidden sm:block">
              <Search
                className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                size={16}
              />
              <input
                type="text"
                placeholder={
                  lang === 'da'
                    ? 'Søg virksomhed, CVR, person...'
                    : 'Search company, CVR, person...'
                }
                className="pl-10 pr-4 py-2 bg-white/5 border border-white/10 rounded-xl text-sm text-slate-300 placeholder-slate-600 focus:outline-none focus:border-blue-500 w-72 transition-colors"
              />
            </div>
          </div>
          <div className="flex items-center gap-3">
            {/* Language toggle */}
            <div className="flex items-center bg-white/10 rounded-full p-1 gap-1">
              <button
                onClick={() => setLang('da')}
                className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all ${
                  lang === 'da' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                DA
              </button>
              <button
                onClick={() => setLang('en')}
                className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all ${
                  lang === 'en' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                EN
              </button>
            </div>
            <button className="relative p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-xl transition-colors">
              <Bell size={20} />
              <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-blue-600 rounded-full" />
            </button>
            <div className="w-9 h-9 bg-blue-600 rounded-full flex items-center justify-center text-white text-sm font-bold cursor-pointer">
              JR
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">{children}</main>
        <FeedbackButton />
      </div>
    </div>
  );
}
