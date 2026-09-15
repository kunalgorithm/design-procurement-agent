import { motion, useReducedMotion } from 'framer-motion';
import { useNavigate } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Slots } from '@/components/landing-page/types';

interface BannerProps {
  className?: string;
  contentClassName?: string;
  showInColumns?: boolean;
  isBlack?: boolean;
  data: Slots;
}

const variants = {
  visible: {
    opacity: 1,
    y: 0,
    transition: { ease: 'easeOut' as const, delay: 0.25, duration: 0.75 },
  },
  hidden: { opacity: 0, y: 75 },
};

const renderDocument = (doc: any, isBlack: boolean, contentClassName?: string) => {
  if (!doc) return null;
  return doc.content.map((para: any, idx: number) => (
    <p
      key={idx}
      className={cn(
        'text-sm font-light leading-6 text-black-700',
        { 'text-white sm:text-black-100': isBlack },
        contentClassName,
      )}
    >
      {para.content.map((text: any) => text.value).join('')}
    </p>
  ));
};

export const BannerComponent = ({ className, contentClassName, data, isBlack, showInColumns }: BannerProps) => {
  const reducedMotion = useReducedMotion();
  const navigate = useNavigate();
  const bannerContent = data.items[0];
  const isSignupAction = bannerContent.actionUrl === '/signup';

  return (
    <motion.div initial={reducedMotion ? false : 'hidden'} animate="visible" variants={variants}>
      <div className={cn('w-full', isBlack ? 'bg-black-700' : 'bg-black-100', className)}>
        <div
          className={cn(
            'form-container flex flex-col items-center gap-y-8 py-14 text-center md:py-20',
            {
              'items-start text-left [&>div]:max-w-2xl':
                showInColumns,
            },
          )}
        >
          <div className="flex max-w-2xl flex-col">
            {bannerContent.description && (
              <p className={cn('mb-2 text-base text-black-700', { 'text-black-50': isBlack })}>
                {bannerContent.description}
              </p>
            )}
            <h2
              className={cn(
                'text-2xl leading-snug text-black-700 md:text-3xl',
                { 'text-white': isBlack },
                { 'text-3xl': showInColumns },
              )}
            >
              {bannerContent.slotTitle}
            </h2>
            {renderDocument(bannerContent.markdown?.json, !!isBlack, contentClassName)}
            {bannerContent.actionText &&
              (isSignupAction ? (
                <button
                  onClick={() => navigate('/signup')}
                  className={cn(
                    'form-button mt-6 self-start',
                    isBlack && 'form-button-light',
                  )}
                >
                  {bannerContent.actionText}
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              ) : (
                <a
                  href={bannerContent.actionUrl ?? undefined}
                  className={cn(
                    'form-button mt-6 self-start',
                    isBlack && 'form-button-light',
                  )}
                >
                  {bannerContent.actionText}
                  <ArrowRight size={18} aria-hidden="true" />
                </a>
              ))}
          </div>
          {bannerContent.photosCollection.items.length > 0 && (
            <div className="flex w-full max-w-lg flex-col">
              <div className="mb-4 flex justify-center gap-8">
                {bannerContent.photosCollection.items.slice(0, 5).map((image) => (
                  <div key={image.title} className="relative h-12 w-full">
                    <img src={image.url} alt={image.title} className="h-full w-full object-contain" />
                  </div>
                ))}
              </div>
              {bannerContent.photosCollection.items.length > 5 && (
                <div className="flex flex-col justify-center gap-4 md:flex-row">
                  {bannerContent.photosCollection.items.slice(5).map((image) => (
                    <div key={image.title} className="relative h-12 w-full md:w-1/5">
                      <img src={image.url} alt={image.title} className="h-full w-full object-contain" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};
