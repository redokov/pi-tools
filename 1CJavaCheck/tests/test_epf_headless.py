# -*- coding: utf-8 -*-
"""Headless tests for JavaCheck.epf on Srvr=localhost;Ref=dev_erpapk_demo.

A. ПроверитьДоступностьДжавы()      - модуль сам выполняет команды ОС.
B. ПроверитьПоДанным(...)           - анализ переданных данных (позитив).
C. ПроверитьПоДанным(...) x3        - негативные сценарии (Джава недоступна).
"""
import sys, os, subprocess, tempfile, json
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
import win32com.client

EPF = r"c:\Tools\1CJavaCheck\JavaCheck.epf"
CS = 'Srvr="localhost";Ref="dev_erpapk_demo";Usr="Администратор (ОрловАВ)";Pwd=""'

M_ALL   = "\u041f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c\u0414\u043e\u0441\u0442\u0443\u043f\u043d\u043e\u0441\u0442\u044c\u0414\u0436\u0430\u0432\u044b"
M_DATA  = "\u041f\u0440\u043e\u0432\u0435\u0440\u0438\u0442\u044c\u041f\u043e\u0414\u0430\u043d\u043d\u044b\u043c"
F_AVAIL = "\u0414\u043e\u0441\u0442\u0443\u043f\u043d\u0430"
F_VER   = "\u0412\u0435\u0440\u0441\u0438\u044f"
F_PATH  = "\u041f\u0443\u0442\u044c\u041aJava"
F_USER  = "\u041f\u043e\u043b\u044c\u0437\u043e\u0432\u0430\u0442\u0435\u043b\u044c"
F_DET   = "\u0414\u0435\u0442\u0430\u043b\u0438"

failures = []


def run_cmd(cmd):
    with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
        out = f.name
    try:
        pr = subprocess.run('cmd /c %s > "%s" 2>&1' % (cmd, out), shell=True)
        raw = open(out, "rb").read()
        for enc in ("utf-8", "cp866", "cp1251"):
            try:
                return raw.decode(enc), pr.returncode
            except UnicodeDecodeError:
                continue
        return raw.decode("utf-8", "replace"), pr.returncode
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass


def as_dict(res):
    return {
        "Доступна": bool(getattr(res, F_AVAIL)),
        "Версия": str(getattr(res, F_VER)),
        "ПутьКJava": str(getattr(res, F_PATH)),
        "Пользователь": str(getattr(res, F_USER)),
        "Детали": str(getattr(res, F_DET)),
    }


def expect(label, got, want_avail):
    ok = got["Доступна"] == want_avail
    print("%-46s Доступна=%-5s %s" % (label, got["Доступна"], "OK" if ok else "FAIL"))
    if not ok:
        failures.append(label)
    print("    Детали: %s" % got["Детали"][:230])
    return ok


def main():
    ib = win32com.client.Dispatch("V85.COMConnector").Connect(CS)
    proc = ib.ExternalDataProcessors.Create(EPF, False)
    print("EPF загружен:", EPF)

    print("\n=== A. ПроверитьДоступностьДжавы() - модуль сам выполняет команды ОС ===")
    got = as_dict(getattr(proc, M_ALL)())
    expect("реальное окружение процесса", got, True)

    whoami, _ = run_cmd("whoami")
    jh, _ = run_cmd("echo %JAVA_HOME%")
    path, _ = run_cmd("set PATH")
    ver, code = run_cmd("java -version")

    print("\n=== B. ПроверитьПоДанным() - позитив (данные собраны вне 1С) ===")
    got = as_dict(getattr(proc, M_DATA)(whoami.strip(), jh.strip(), path, code, ver))
    expect("java -version код 0 + вывод с version", got, True)

    print("\n=== C. Негативные сценарии ===")
    cases = [
        ("нет JAVA_HOME, пустой PATH, код 1",
         ("test", "", "", 1, "")),
        ("JAVA_HOME на несуществующий каталог",
         ("test", "C:\\NoSuchJava", "PATH=C:\\NoSuchDir", 1,
          "'java' is not recognized as an internal or external command")),
        ("код 0, но вывод без 'version'",
         ("test", "", "", 0, "some unexpected output")),
    ]
    for label, args in cases:
        got = as_dict(getattr(proc, M_DATA)(*args))
        expect(label, got, False)

    print("\n" + ("ИТОГ: все проверки пройдены" if not failures
                  else "ИТОГ: провалено - %s" % ", ".join(failures)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
