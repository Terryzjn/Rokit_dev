using System;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Controls;
// 别名：干掉 System.IO.Path 与 System.Windows.Shapes.Path 之间的歧义。
// 别名使 C# 编译器在裸名 Path 上固定选择 Shapes.Path，同时仍可使用完全限定名
// System.IO.Path 调用文件 IO（如 File.OpenWrite）。
using Path = System.Windows.Shapes.Path;

public class IconRenderer
{
  // 用 Convert.ToByte 替代 Convert.ToInt32 + cast，更稳
  static byte B(string hex2) { return Convert.ToByte(hex2, 16); }

  static Color MakeColor(string hex)
  {
    string h = hex.TrimStart('#');
    return Color.FromArgb(
      (byte)255,
      B(h.Substring(0, 2)),
      B(h.Substring(2, 2)),
      B(h.Substring(4, 2)));
  }

  // 颜色常量（与 web/public/favicon.svg 完全一致）
  static readonly Color C_BODY_TOP    = MakeColor("#94D4D0");
  static readonly Color C_BODY_BOTTOM = MakeColor("#0E7C7B");
  static readonly Color C_BODY_STROKE = MakeColor("#0E7C7B");
  static readonly Color C_WING        = MakeColor("#1F9C9A");
  static readonly Color C_WIN_OUTER   = MakeColor("#0a0e14");
  static readonly Color C_WIN_INNER   = MakeColor("#4DD0E1");
  static readonly Color C_FLAME_TOP   = MakeColor("#F472B6");
  static readonly Color C_FLAME_BOTTOM = MakeColor("#8B5CF6");
  static readonly Color C_BG_DARK_TOP = MakeColor("#0E7C7B");
  static readonly Color C_BG_DARK_BOT = MakeColor("#1FA8A0");
  static readonly Color C_BG_LIGHT_TOP = MakeColor("#E2F0EF");
  static readonly Color C_BG_LIGHT_BOT = MakeColor("#FFFFFF");

  static LinearGradientBrush VertGrad(Color top, Color bottom)
  {
    var g = new LinearGradientBrush();
    g.StartPoint = new Point(0, 0);
    g.EndPoint = new Point(0, 1);
    g.GradientStops.Add(new GradientStop(top, 0.0));
    g.GradientStops.Add(new GradientStop(bottom, 1.0));
    return g;
  }

  // 火箭主体（与 favicon.svg 同比例：64x64 viewBox，缩放到 1024x1024）
  static Geometry MakeBodyGeometry()
  {
    var fig = new PathFigure { StartPoint = new Point(512, 64), IsClosed = true };
    fig.Segments.Add(new BezierSegment(
      new Point(752, 224), new Point(784, 416), new Point(784, 608), true));
    fig.Segments.Add(new LineSegment(new Point(784, 800), true));
    fig.Segments.Add(new LineSegment(new Point(240, 800), true));
    fig.Segments.Add(new LineSegment(new Point(240, 608), true));
    fig.Segments.Add(new BezierSegment(
      new Point(240, 416), new Point(272, 224), new Point(512, 64), true));
    var geo = new PathGeometry();
    geo.Figures.Add(fig);
    return geo;
  }

  static Geometry MakeWingGeometry(bool right)
  {
    var fig = new PathFigure { IsClosed = true };
    if (right)
    {
      fig.StartPoint = new Point(784, 624);
      fig.Segments.Add(new LineSegment(new Point(880, 800), true));
      fig.Segments.Add(new LineSegment(new Point(784, 800), true));
    }
    else
    {
      fig.StartPoint = new Point(240, 624);
      fig.Segments.Add(new LineSegment(new Point(144, 800), true));
      fig.Segments.Add(new LineSegment(new Point(240, 800), true));
    }
    var geo = new PathGeometry();
    geo.Figures.Add(fig);
    return geo;
  }

  static Geometry MakeFlameGeometry()
  {
    var fig = new PathFigure { StartPoint = new Point(448, 800), IsClosed = true };
    fig.Segments.Add(new LineSegment(new Point(480, 960), true));
    fig.Segments.Add(new LineSegment(new Point(512, 880), true));
    fig.Segments.Add(new LineSegment(new Point(544, 960), true));
    fig.Segments.Add(new LineSegment(new Point(576, 800), true));
    var geo = new PathGeometry();
    geo.Figures.Add(fig);
    return geo;
  }

  static Canvas BuildCanvas(Brush background)
  {
    var canvas = new Canvas { Width = 1024, Height = 1024, Background = background };

    var body = new Path
    {
      Data = MakeBodyGeometry(),
      Fill = VertGrad(C_BODY_TOP, C_BODY_BOTTOM),
      Stroke = new SolidColorBrush(C_BODY_STROKE),
      StrokeThickness = 4
    };
    Canvas.SetLeft(body, 0); Canvas.SetTop(body, 0);
    canvas.Children.Add(body);

    var leftWing = new Path
    {
      Data = MakeWingGeometry(false),
      Fill = new SolidColorBrush(C_WING)
    };
    Canvas.SetLeft(leftWing, 0); Canvas.SetTop(leftWing, 0);
    canvas.Children.Add(leftWing);

    var rightWing = new Path
    {
      Data = MakeWingGeometry(true),
      Fill = new SolidColorBrush(C_WING)
    };
    Canvas.SetLeft(rightWing, 0); Canvas.SetTop(rightWing, 0);
    canvas.Children.Add(rightWing);

    var winOuter = new Ellipse
    {
      Width = 192, Height = 192,
      Fill = new SolidColorBrush(C_WIN_OUTER)
    };
    Canvas.SetLeft(winOuter, 416); Canvas.SetTop(winOuter, 312);
    canvas.Children.Add(winOuter);

    var winInner = new Ellipse
    {
      Width = 112, Height = 112,
      Fill = new SolidColorBrush(C_WIN_INNER)
    };
    Canvas.SetLeft(winInner, 456); Canvas.SetTop(winInner, 352);
    canvas.Children.Add(winInner);

    var flame = new Path
    {
      Data = MakeFlameGeometry(),
      Fill = VertGrad(C_FLAME_TOP, C_FLAME_BOTTOM)
    };
    Canvas.SetLeft(flame, 0); Canvas.SetTop(flame, 0);
    canvas.Children.Add(flame);

    return canvas;
  }

  static void SavePng(FrameworkElement visual, string outPath, int size)
  {
    // Canvas 必须先布局（Measure+Arrange）才能被 RenderTargetBitmap 正确渲染子元素，
    // 否则只会输出背景，子元素全部丢重。
    visual.Measure(new Size(size, size));
    visual.Arrange(new Rect(0, 0, size, size));
    visual.UpdateLayout();

    // WPF 资源释放说明：
    // RenderTargetBitmap / PngBitmapEncoder / BitmapFrame 都不实现 IDisposable
    // （继承链 RenderTargetBitmap → BitmapSource → ImageSource → Animatable →
    // Freezable → DispatcherObject，无 IDisposable），不能用 using 包裹。
    // 正确做法是 Render 后调用 Freeze() 令对象 immutable 并让 GC finalizer
    // 更早回收 native handle；FileStream 则仍需 using 包裹。
    var rtb = new RenderTargetBitmap(size, size, 96, 96, PixelFormats.Pbgra32);
    rtb.Render(visual);
    rtb.Freeze();
    var enc = new PngBitmapEncoder();
    enc.Frames.Add(BitmapFrame.Create(rtb));
    using (var fs = File.OpenWrite(outPath))
    {
      enc.Save(fs);
    }
    // 出作用域后 rtb / enc / frame 交由 GC 回收；rtb.Freeze() 已加速该过程。
  }

  // 入口：args[0]=darkOut, args[1]=lightOut
  // STA 是 WPF 渲染的硬性要求（单线程单元），否则 RenderTargetBitmap 会抛
  // "调用线程必须为 STA，因为许多 UI 组件都需要"
  [STAThread]
  public static int Main(string[] args)
  {
    if (args.Length < 2)
    {
      Console.Error.WriteLine("[render-icon] 用法：IconRenderer.exe <darkOut> <lightOut>");
      return 1;
    }
    try
    {
      // 深色背景版（深青 → 亮青）
      var darkBg = VertGrad(C_BG_DARK_TOP, C_BG_DARK_BOT);
      var darkCanvas = BuildCanvas(darkBg);
      SavePng(darkCanvas, args[0], 1024);
      Console.WriteLine("[render-icon] ✓ " + args[0] + " (" +
        Math.Round(new FileInfo(args[0]).Length / 1024.0, 1) + " KB)");

      // 亮色背景版（浅青 → 白色）
      var lightBg = VertGrad(C_BG_LIGHT_TOP, C_BG_LIGHT_BOT);
      var lightCanvas = BuildCanvas(lightBg);
      SavePng(lightCanvas, args[1], 1024);
      Console.WriteLine("[render-icon] ✓ " + args[1] + " (" +
        Math.Round(new FileInfo(args[1]).Length / 1024.0, 1) + " KB)");

      return 0;
    }
    catch (Exception e)
    {
      Console.Error.WriteLine("[render-icon] ✗ " + e.Message);
      return 1;
    }
  }
}