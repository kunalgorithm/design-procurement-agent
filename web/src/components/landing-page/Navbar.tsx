import { Link } from 'react-router';
import { FormLogo } from '@/components/ui/FormLogo';

export function Navbar() {
  return (
    <nav className="sticky top-0 z-50 bg-white border-b border-gray-200" aria-label="Main navigation">
      <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
        <Link to="/" aria-label="FORM home"><FormLogo /></Link>
        <Link className="text-sm text-gray-700 hover:text-black" to="/signup">Get started</Link>
      </div>
    </nav>
  );
}
