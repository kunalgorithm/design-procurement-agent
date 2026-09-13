import { motion } from 'framer-motion';
import { useNavigate } from 'react-router';
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
  const navigate = useNavigate();
  const bannerContent = data.items[0];
  const isSignupAction = bannerContent.actionUrl === '/signup';

  return (
    <motion.div initial="hidden" animate="visible" variants={variants}>
      <div className={cn('w-full', isBlack ? 'bg-black-700' : 'bg-black-100', className)}>
        <div
          className={cn(
            'mx-auto flex w-full max-w-7xl flex-col items-center gap-y-8 px-14 py-20 text-center sm:px-36 sm:py-44 md:px-56',
            {
              'justify-between gap-x-6 md:flex-row md:px-10 lg:px-52 xl:justify-center xl:gap-x-16 xl:px-0 [&>div]:max-w-96 [&>div]:text-left':
                showInColumns,
            },
          )}
        >
          <div className="flex flex-col">
            {bannerContent.description && (
              <p className={cn('mb-2 text-base text-black-700', { 'text-black-50': isBlack })}>
                {bannerContent.description}
              </p>
            )}
            <h6
              className={cn(
                'leading-relaxed text-black-700 md:text-3xl md:leading-relaxed',
                { 'text-white': isBlack },
                { 'text-3xl': showInColumns },
              )}
            >
              {bannerContent.slotTitle}
            </h6>
            {renderDocument(bannerContent.markdown?.json, !!isBlack, contentClassName)}
            {bannerContent.actionText &&
              (isSignupAction ? (
                <button
                  onClick={() => navigate('/signup')}
                  className={cn(
                    'mt-6 inline-flex items-center justify-center h-9 px-4 py-2 rounded-xs text-sm font-light capitalize transition-colors self-start',
                    isBlack
                      ? 'bg-secondary text-secondary-foreground hover:bg-secondary-hover focus-visible:bg-secondary-hover active:bg-secondary/90'
                      : 'bg-primary text-primary-foreground hover:bg-primary-hover focus-visible:bg-primary-hover active:bg-primary/90',
                  )}
                >
                  {bannerContent.actionText}
                </button>
              ) : (
                <a
                  href={bannerContent.actionUrl ?? undefined}
                  className={cn(
                    'mt-6 inline-flex items-center justify-center h-9 px-4 py-2 rounded-xs text-sm font-light capitalize transition-colors self-start',
                    isBlack
                      ? 'bg-secondary text-secondary-foreground hover:bg-secondary-hover focus-visible:bg-secondary-hover active:bg-secondary/90'
                      : 'bg-primary text-primary-foreground hover:bg-primary-hover focus-visible:bg-primary-hover active:bg-primary/90',
                  )}
                >
                  {bannerContent.actionText}
                </a>
              ))}
          </div>
          {bannerContent.photosCollection.items.length > 0 && (
            <div className="flex w-full flex-col">
              <div className="mb-4 flex flex-col justify-center gap-4 md:flex-row">
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
