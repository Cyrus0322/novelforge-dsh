export type Navigate = (path: string) => void

export interface PageProps {
  projectId: string
  navigate: Navigate
}

export interface ChapterPageProps extends PageProps {
  chapterId: string
}
