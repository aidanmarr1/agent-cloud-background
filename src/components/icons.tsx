import { forwardRef } from 'react'
import type { Icon, IconProps, IconWeight } from '@phosphor-icons/react/dist/lib/types'
import { PulseIcon as PhActivity } from '@phosphor-icons/react/dist/csr/Pulse'
import { ArchiveIcon as PhArchive } from '@phosphor-icons/react/dist/csr/Archive'
import { ArrowClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowClockwise'
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise'
import { ArrowDownIcon as PhArrowDown } from '@phosphor-icons/react/dist/csr/ArrowDown'
import { ArrowElbowDownLeftIcon } from '@phosphor-icons/react/dist/csr/ArrowElbowDownLeft'
import { ArrowRightIcon as PhArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight'
import { ArrowSquareOutIcon } from '@phosphor-icons/react/dist/csr/ArrowSquareOut'
import { ArrowUpIcon as PhArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp'
import { ArrowUpRightIcon as PhArrowUpRight } from '@phosphor-icons/react/dist/csr/ArrowUpRight'
import { BellIcon as PhBell } from '@phosphor-icons/react/dist/csr/Bell'
import { BookOpenIcon as PhBookOpen } from '@phosphor-icons/react/dist/csr/BookOpen'
import { BooksIcon } from '@phosphor-icons/react/dist/csr/Books'
import { BrainIcon as PhBrain } from '@phosphor-icons/react/dist/csr/Brain'
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown'
import { CaretLeftIcon } from '@phosphor-icons/react/dist/csr/CaretLeft'
import { CaretRightIcon } from '@phosphor-icons/react/dist/csr/CaretRight'
import { CaretUpIcon } from '@phosphor-icons/react/dist/csr/CaretUp'
import { ChartBarIcon } from '@phosphor-icons/react/dist/csr/ChartBar'
import { ChatCircleIcon } from '@phosphor-icons/react/dist/csr/ChatCircle'
import { CheckIcon as PhCheck } from '@phosphor-icons/react/dist/csr/Check'
import { CheckCircleIcon } from '@phosphor-icons/react/dist/csr/CheckCircle'
import { CircleIcon as PhCircle } from '@phosphor-icons/react/dist/csr/Circle'
import { ClockIcon as PhClock } from '@phosphor-icons/react/dist/csr/Clock'
import { CodeIcon as PhCode } from '@phosphor-icons/react/dist/csr/Code'
import { CompassIcon } from '@phosphor-icons/react/dist/csr/Compass'
import { CopyIcon as PhCopy } from '@phosphor-icons/react/dist/csr/Copy'
import { CornersInIcon } from '@phosphor-icons/react/dist/csr/CornersIn'
import { CornersOutIcon } from '@phosphor-icons/react/dist/csr/CornersOut'
import { DatabaseIcon as PhDatabase } from '@phosphor-icons/react/dist/csr/Database'
import { DeviceMobileIcon } from '@phosphor-icons/react/dist/csr/DeviceMobile'
import { DeviceTabletIcon } from '@phosphor-icons/react/dist/csr/DeviceTablet'
import { DotsThreeIcon } from '@phosphor-icons/react/dist/csr/DotsThree'
import { DownloadSimpleIcon } from '@phosphor-icons/react/dist/csr/DownloadSimple'
import { EraserIcon as PhEraser } from '@phosphor-icons/react/dist/csr/Eraser'
import { EyeSlashIcon } from '@phosphor-icons/react/dist/csr/EyeSlash'
import { FileCodeIcon as PhFileCode } from '@phosphor-icons/react/dist/csr/FileCode'
import { FileIcon as PhFile } from '@phosphor-icons/react/dist/csr/File'
import { FilePlusIcon as PhFilePlus } from '@phosphor-icons/react/dist/csr/FilePlus'
import { FileTextIcon as PhFileText } from '@phosphor-icons/react/dist/csr/FileText'
import { FireIcon } from '@phosphor-icons/react/dist/csr/Fire'
import { FolderOpenIcon as PhFolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen'
import { FolderSimplePlusIcon } from '@phosphor-icons/react/dist/csr/FolderSimplePlus'
import { GearSixIcon } from '@phosphor-icons/react/dist/csr/GearSix'
import { GitBranchIcon as PhGitBranch } from '@phosphor-icons/react/dist/csr/GitBranch'
import { GlobeIcon as PhGlobe } from '@phosphor-icons/react/dist/csr/Globe'
import { GridFourIcon } from '@phosphor-icons/react/dist/csr/GridFour'
import { HardDrivesIcon } from '@phosphor-icons/react/dist/csr/HardDrives'
import { HouseIcon } from '@phosphor-icons/react/dist/csr/House'
import { ImageIcon as PhImage } from '@phosphor-icons/react/dist/csr/Image'
import { ImageSquareIcon } from '@phosphor-icons/react/dist/csr/ImageSquare'
import { InfoIcon as PhInfo } from '@phosphor-icons/react/dist/csr/Info'
import { KeyIcon } from '@phosphor-icons/react/dist/csr/Key'
import { KeyboardIcon as PhKeyboard } from '@phosphor-icons/react/dist/csr/Keyboard'
import { LightningIcon } from '@phosphor-icons/react/dist/csr/Lightning'
import { LinkIcon as PhLink } from '@phosphor-icons/react/dist/csr/Link'
import { ListIcon } from '@phosphor-icons/react/dist/csr/List'
import { MagnifyingGlassIcon } from '@phosphor-icons/react/dist/csr/MagnifyingGlass'
import { MonitorIcon as PhMonitor } from '@phosphor-icons/react/dist/csr/Monitor'
import { MonitorPlayIcon as PhMonitorPlay } from '@phosphor-icons/react/dist/csr/MonitorPlay'
import { MoonIcon as PhMoon } from '@phosphor-icons/react/dist/csr/Moon'
import { NotePencilIcon } from '@phosphor-icons/react/dist/csr/NotePencil'
import { PaletteIcon as PhPalette } from '@phosphor-icons/react/dist/csr/Palette'
import { PaperclipIcon as PhPaperclip } from '@phosphor-icons/react/dist/csr/Paperclip'
import { PencilSimpleIcon } from '@phosphor-icons/react/dist/csr/PencilSimple'
import { PlayIcon as PhPlay } from '@phosphor-icons/react/dist/csr/Play'
import { PlusIcon as PhPlus } from '@phosphor-icons/react/dist/csr/Plus'
import { PresentationIcon as PhPresentation } from '@phosphor-icons/react/dist/csr/Presentation'
import { PushPinIcon } from '@phosphor-icons/react/dist/csr/PushPin'
import { RobotIcon } from '@phosphor-icons/react/dist/csr/Robot'
import { ShieldCheckIcon as PhShieldCheck } from '@phosphor-icons/react/dist/csr/ShieldCheck'
import { SidebarSimpleIcon } from '@phosphor-icons/react/dist/csr/SidebarSimple'
import { SignOutIcon } from '@phosphor-icons/react/dist/csr/SignOut'
import { SkipBackIcon as PhSkipBack } from '@phosphor-icons/react/dist/csr/SkipBack'
import { SkipForwardIcon as PhSkipForward } from '@phosphor-icons/react/dist/csr/SkipForward'
import { SlidersHorizontalIcon as PhSlidersHorizontal } from '@phosphor-icons/react/dist/csr/SlidersHorizontal'
import { SlidersIcon as PhSliders } from '@phosphor-icons/react/dist/csr/Sliders'
import { SpeakerHighIcon } from '@phosphor-icons/react/dist/csr/SpeakerHigh'
import { SpinnerGapIcon } from '@phosphor-icons/react/dist/csr/SpinnerGap'
import { SquareIcon as PhSquare } from '@phosphor-icons/react/dist/csr/Square'
import { StarIcon as PhStar } from '@phosphor-icons/react/dist/csr/Star'
import { SunIcon as PhSun } from '@phosphor-icons/react/dist/csr/Sun'
import { TerminalIcon as PhTerminal } from '@phosphor-icons/react/dist/csr/Terminal'
import { TrashIcon as PhTrash } from '@phosphor-icons/react/dist/csr/Trash'
import { UploadSimpleIcon } from '@phosphor-icons/react/dist/csr/UploadSimple'
import { UserIcon as PhUser } from '@phosphor-icons/react/dist/csr/User'
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle'
import { WarningIcon } from '@phosphor-icons/react/dist/csr/Warning'
import { XCircleIcon as PhXCircle } from '@phosphor-icons/react/dist/csr/XCircle'
import { XIcon as PhX } from '@phosphor-icons/react/dist/csr/X'

type AppIconProps = Omit<IconProps, 'weight'> & {
  strokeWidth?: number
  weight?: IconWeight
}

export type LucideIcon = ReturnType<typeof makeIcon>

function makeIcon(BaseIcon: Icon, defaultWeight: IconWeight = 'regular') {
  const WrappedIcon = forwardRef<SVGSVGElement, AppIconProps>(
    ({ strokeWidth: _strokeWidth, fill, weight, ...props }, ref) => (
      <BaseIcon
        ref={ref}
        weight={weight ?? (fill && fill !== 'none' ? 'fill' : defaultWeight)}
        {...props}
      />
    )
  )
  WrappedIcon.displayName = BaseIcon.displayName || BaseIcon.name || 'Icon'
  return WrappedIcon
}

const makeControlIcon = (icon: Icon) => makeIcon(icon, 'bold')

export const Activity = makeIcon(PhActivity)
export const AlertCircle = makeIcon(WarningCircleIcon)
export const AlertTriangle = makeIcon(WarningIcon)
export const Archive = makeIcon(PhArchive)
export const ArrowDown = makeControlIcon(PhArrowDown)
export const ArrowRight = makeControlIcon(PhArrowRight)
export const ArrowUp = makeControlIcon(PhArrowUp)
export const ArrowUpRight = makeControlIcon(PhArrowUpRight)
export const BarChart3 = makeIcon(ChartBarIcon)
export const Bell = makeIcon(PhBell)
export const BookOpen = makeIcon(PhBookOpen)
export const Bot = makeIcon(RobotIcon)
export const Brain = makeIcon(PhBrain)
export const Check = makeControlIcon(PhCheck)
export const CheckCircle = makeIcon(CheckCircleIcon)
export const CheckCircle2 = makeIcon(CheckCircleIcon)
export const ChevronDown = makeControlIcon(CaretDownIcon)
export const ChevronLeft = makeControlIcon(CaretLeftIcon)
export const ChevronRight = makeControlIcon(CaretRightIcon)
export const ChevronUp = makeControlIcon(CaretUpIcon)
export const Circle = makeControlIcon(PhCircle)
export const Clock = makeIcon(PhClock)
export const Code = makeIcon(PhCode)
export const Code2 = makeIcon(PhCode)
export const Compass = makeIcon(CompassIcon)
export const Copy = makeIcon(PhCopy)
export const CornerDownLeft = makeIcon(ArrowElbowDownLeftIcon)
export const Database = makeIcon(PhDatabase)
export const Download = makeIcon(DownloadSimpleIcon)
export const Edit3 = makeIcon(PencilSimpleIcon)
export const Eraser = makeIcon(PhEraser)
export const ExternalLink = makeControlIcon(ArrowSquareOutIcon)
export const EyeOff = makeIcon(EyeSlashIcon)
export const File = makeIcon(PhFile)
export const FileCode = makeIcon(PhFileCode)
export const FilePlus = makeIcon(PhFilePlus)
export const FileText = makeIcon(PhFileText)
export const Flame = makeIcon(FireIcon)
export const FolderOpen = makeIcon(PhFolderOpen)
export const FolderUp = makeIcon(FolderSimplePlusIcon)
export const GitBranch = makeIcon(PhGitBranch)
export const Globe = makeIcon(PhGlobe)
export const Globe2 = makeIcon(PhGlobe)
export const HardDrive = makeIcon(HardDrivesIcon)
export const Home = makeIcon(HouseIcon)
export const Image = makeIcon(PhImage)
export const ImageIcon = makeIcon(ImageSquareIcon)
export const ImageSearch = forwardRef<SVGSVGElement, AppIconProps>(
  ({ size = 24, strokeWidth = 1.8, className, weight: _weight, ...props }, ref) => (
    <svg
      ref={ref}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      {...props}
    >
      <rect x="3.25" y="3.25" width="13.5" height="13.5" rx="2.35" stroke="currentColor" strokeWidth={strokeWidth} />
      <circle cx="8.2" cy="8.15" r="1.45" fill="currentColor" />
      <path d="M5.8 14.2l3.15-3.2 2.45 2.35 1.8-1.75 1.25 1.25" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16.3" cy="16.35" r="3.15" stroke="currentColor" strokeWidth={strokeWidth} />
      <path d="M18.65 18.7L21 21" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  )
)
ImageSearch.displayName = 'ImageSearch'
export const Info = makeIcon(PhInfo)
export const KeyRound = makeIcon(KeyIcon)
export const Keyboard = makeIcon(PhKeyboard)
export const LayoutGrid = makeIcon(GridFourIcon)
export const Link = makeIcon(PhLink)
export const Loader2 = makeIcon(SpinnerGapIcon)
export const LogOut = makeIcon(SignOutIcon)
export const Maximize2 = makeIcon(CornersOutIcon)
export const Menu = makeControlIcon(ListIcon)
export const MessageSquare = makeIcon(ChatCircleIcon)
export const Minimize2 = makeIcon(CornersInIcon)
export const Monitor = makeIcon(PhMonitor)
export const MonitorPlay = makeIcon(PhMonitorPlay)
export const Moon = makeIcon(PhMoon)
export const MoreHorizontal = makeControlIcon(DotsThreeIcon)
export const Palette = makeIcon(PhPalette)
export const Paperclip = makeIcon(PhPaperclip)
export const Pencil = makeIcon(PencilSimpleIcon)
export const PanelLeftClose = makeIcon(SidebarSimpleIcon)
export const PanelLeftOpen = makeIcon(SidebarSimpleIcon)
export const PenSquare = makeIcon(NotePencilIcon)
export const Pin = makeIcon(PushPinIcon)
export const Play = makeIcon(PhPlay)
export const Plus = makeControlIcon(PhPlus)
export const Presentation = makeIcon(PhPresentation)
export const RefreshCw = makeIcon(ArrowClockwiseIcon)
export const RotateCcw = makeIcon(ArrowCounterClockwiseIcon)
export const Search = makeIcon(MagnifyingGlassIcon)
export const Settings = makeIcon(GearSixIcon)
export const ShieldCheck = makeIcon(PhShieldCheck)
export const SkipBack = makeControlIcon(PhSkipBack)
export const SkipForward = makeControlIcon(PhSkipForward)
export const Sliders = makeIcon(PhSliders)
export const SlidersHorizontal = makeIcon(PhSlidersHorizontal)
export const Smartphone = makeIcon(DeviceMobileIcon)
export const Sparkles = makeIcon(LightningIcon)
export const Square = makeControlIcon(PhSquare)
export const Star = makeIcon(PhStar)
export const Sun = makeIcon(PhSun)
export const Tablet = makeIcon(DeviceTabletIcon)
export const Terminal = makeIcon(PhTerminal)
export const Trash2 = makeIcon(PhTrash)
export const Upload = makeIcon(UploadSimpleIcon)
export const User = makeIcon(PhUser)
export const Library = makeIcon(BooksIcon)
export const Volume2 = makeIcon(SpeakerHighIcon)
export const X = makeControlIcon(PhX)
export const XCircle = makeIcon(PhXCircle)
export const Zap = makeIcon(LightningIcon)
