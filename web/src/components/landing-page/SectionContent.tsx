import { motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import type { Slots } from '@/components/landing-page/types';

interface SectionContentProps {
  className?: string;
  contentClassName?: string;
  imgClassName?: string;
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

const renderDocument = (doc: any) => {
  if (!doc) return null;
  return doc.content.map((para: any, idx: number) => (
    <p key={idx} className="mt-4 text-base font-light leading-7 text-black-700 md:mt-10">
      {para.content.map((text: any) => text.value).join('')}
    </p>
  ));
};

export const SectionContent = ({ className, contentClassName, imgClassName, data }: SectionContentProps) => {
  const sectionContent = data.items?.[0];
  const isVideo = sectionContent.photosCollection?.items?.[0]?.contentType?.includes('video');

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={variants}
      className={cn('lg:grid lg:grid-cols-12', className)}
    >
      <div
        className={cn('lg:col-span-10 lg:col-start-2 mx-auto flex w-full max-w-screen-xl flex-col md:flex-row', {
          'md:flex-row-reverse': !!sectionContent.isLeft,
        })}
      >
        <div
          className={cn(
            'flex w-full flex-col justify-center p-8 sm:px-32 sm:py-20 md:w-1/2 md:px-16 md:py-8 lg:px-20 xl:px-32',
            contentClassName,
          )}
        >
          <h4 className="leading-9 text-black-700 max-sm:text-2xl md:leading-normal">{sectionContent.slotTitle}</h4>
          {renderDocument(sectionContent.markdown?.json)}
          {sectionContent.actionText && sectionContent.actionUrl && (
            <div className="mt-14">
              <a
                href={sectionContent.actionUrl}
                className="inline-flex items-center justify-center h-9 w-full sm:w-max px-4 py-2 rounded-xs text-sm font-light capitalize bg-primary text-primary-foreground hover:bg-primary-hover focus-visible:bg-primary-hover active:bg-primary/90 transition-colors"
              >
                {sectionContent.actionText}
              </a>
            </div>
          )}
        </div>
        <div className="w-full md:w-1/2">
          {sectionContent.photosCollection?.items?.[0] && (
            <>
              {isVideo ? (
                <video
                  autoPlay
                  loop
                  muted
                  playsInline
                  src={sectionContent.photosCollection.items[0].url}
                  className={cn('h-full w-full', imgClassName)}
                >
                  <track kind="captions" />
                </video>
              ) : (
                <img
                  src={sectionContent.photosCollection.items[0].url}
                  alt={sectionContent.photosCollection.items[0].title}
                  className={cn('aspect-[9/10] w-full object-cover object-center md:object-contain', imgClassName)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
};
