export interface ContentfulText {
  data: Record<string, unknown>;
  marks: readonly unknown[];
  value: string;
  nodeType: 'text';
}

export interface ContentfulParagraph {
  data: Record<string, unknown>;
  content: readonly ContentfulText[];
  nodeType: 'paragraph';
}

export interface ContentfulDocument {
  data: Record<string, unknown>;
  content: readonly ContentfulParagraph[];
  nodeType: 'document';
}

export interface Photo {
  url: string;
  contentType: string;
  title: string;
}

export interface Video {
  title: string;
  embedUrl: string;
}

export interface SlotItem {
  markdown?: {
    json: ContentfulDocument;
  } | null;
  video?: Video | null;
  slotTitle: string;
  actionText?: string | null;
  actionUrl?: string | null;
  description?: string | null;
  isLeft?: boolean | null;
  meta?: {
    imageMapUrl?: string;
    mapUrl?: string;
  } | null;
  photosCollection: {
    items: readonly Photo[];
  };
}

export interface Slots {
  total: number;
  items: readonly SlotItem[];
}
