export function requestsSharedScreen(text){
 const value=String(text||'');
 if(/(?:添加|增加|实现|修复|功能|不要|不用|别发|停止发送)/u.test(value))return false;
 return /(?:发|传|给我).{0,10}(?:共享画面|共享屏幕|当前画面|屏幕截图|截图)|(?:共享画面|共享屏幕|当前画面|屏幕截图|截图).{0,10}(?:发我|发给我|给我|发来|传来|发过来)/u.test(value);
}

export function requestsScreenPicker(text){
 const value=String(text||'').trim().replace(/[。！!？?]+$/u,'');
 if(/(?:添加|增加|实现|修复|功能|怎么|如何|支持|不要|不想|不用|停止|关闭|取消|别|发给我|发我|发来|发送|截图)/u.test(value))return false;
 return /^(?:(?:助手|小宁)[，,\s]*)?(?:(?:请|帮我|现在|我要|我想|开始|开启|打开|启动|来)\s*)*(?:共享(?:一下)?(?:我的|电脑的)?(?:屏幕|窗口)|(?:看|看看|看一下)(?:我|我的)(?:电脑)?屏幕|陪我工作)(?:一下|吧|给你看|，?陪我工作)?$/u.test(value);
}
