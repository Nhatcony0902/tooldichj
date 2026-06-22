pipeline {
    agent any

    tools {
        // Cấu hình tên NodeJS Tool trong Jenkins (Sẽ được cấu hình ở Global Tool Configuration)
        nodejs 'NodeJS-20'
    }

    stages {
        stage('Prepare') {
            steps {
                echo 'Bắt đầu quy trình CI/CD cho ToolDichJ...'
                sh 'node -v'
                sh 'npm -v'

                // ffmpeg là yêu cầu bắt buộc cho pipeline xử lý video (trích xuất audio, chèn sub, lồng tiếng)
                echo 'Kiểm tra / cài đặt ffmpeg...'
                sh '''
                    if ! ffmpeg -version > /dev/null 2>&1; then
                        (apt-get update && apt-get install -y ffmpeg) || echo "CẢNH BÁO: Không cài được ffmpeg trên Jenkins agent này — pipeline xử lý video sẽ báo lỗi lúc runtime (xem GET /health)."
                    fi
                '''
            }
        }

        stage('Build & Test Backend') {
            steps {
                echo 'Đang thiết lập Backend...'
                dir('backend') {
                    // Cài đặt dependencies
                    sh 'npm install'
                    
                    // Khởi tạo Prisma Client
                    echo 'Đang khởi tạo Prisma Client...'
                    sh 'npx prisma generate'
                    
                    // Chạy linter kiểm tra code
                    echo 'Đang chạy Lint kiểm tra chất lượng code Backend...'
                    sh 'npm run lint'
                    
                    // Chạy build thử nghiệm
                    echo 'Đang chạy Build thử nghiệm Backend...'
                    sh 'npm run build'
                }
            }
        }

        stage('Build & Test Frontend') {
            steps {
                echo 'Đang thiết lập Frontend...'
                dir('frontend') {
                    // Cài đặt dependencies
                    sh 'npm install'
                    
                    // Chạy linter kiểm tra code
                    echo 'Đang chạy Lint kiểm tra chất lượng code Frontend...'
                    sh 'npm run lint'
                    
                    // Chạy build thử nghiệm
                    echo 'Đang chạy Build thử nghiệm Frontend...'
                    sh 'npm run build'
                }
            }
        }
    }

    post {
        success {
            echo 'Chúc mừng! Pipeline chạy thành công và toàn bộ code đã qua kiểm thử.'
        }
        failure {
            echo 'Ối! Có bước nào đó bị lỗi rồi. Vui lòng kiểm tra lại log.'
        }
    }
}
